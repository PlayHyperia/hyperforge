/**
 * Agent Routes - ElizaOS Agent Credential Management
 *
 * REST API endpoints for generating 7-day authentication credentials for AI agents.
 * Agents need long-lived tokens to connect autonomously without user intervention.
 *
 * Security Model:
 * - Only Privy-authenticated users can create agent credentials
 * - Credentials are tied to specific characterId + userId pairs
 * - JWTs are server-signed and cryptographically secure
 * - Agents are clearly marked with isAgent flag
 * - Process-local load shedding plus shared PostgreSQL authentication limits
 *   protect the credential boundary across replicas
 *
 * Note: Dashboard on port 3333 calls ElizaOS API (port 3000) directly.
 * No proxying is needed for localhost development.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { World } from "@hyperforge/shared";
import { getDefaultPublicWsUrl } from "../../shared/public-ws-url.js";
import { createJWT } from "../../shared/utils.js";
import {
  buildAgentCredentialJwtPayload,
  type AgentCredentialSession,
} from "../../infrastructure/auth/agent-credential-session.js";
import {
  hydrateThoughtsFromDb,
  recordAgentThought,
  resolveDashboardIntent,
} from "../../eliza/dashboardInterop.js";
import type {
  AgentCharacterConfig,
  EmbeddedAgentInfo,
} from "../../eliza/types.js";
import {
  deletePersistedStreamingDuelMapping,
  executeOwnedAgentMutation,
  savePersistedAgentMapping,
  updatePersistedStreamingDuelParticipation,
} from "../../database/streaming-duel-participation.js";
import {
  issueSolanaAgentAuthChallenge,
  SolanaAgentAuthProvisioningError,
  SolanaAgentAuthRateLimitError,
  SolanaAgentAuthRejectedError,
  verifyAndConsumeSolanaAgentAuthChallenge,
} from "../../database/solana-agent-auth.js";
import {
  AgentCredentialSessionRejectedError,
  revokeAgentCredentialSessions,
  rotateAgentCredentialSession,
  verifyAgentCredentialSession,
} from "../../database/agent-credential-sessions.js";
import {
  canonicalizeSolanaWalletAddress,
  normalizeRequestedCharacterId,
  normalizeSolanaAgentName,
  readSolanaAgentAuthConfig,
  requestMatchesSolanaAgentAuthConfig,
  SolanaAgentAuthConfigurationError,
  SolanaAgentAuthInputError,
} from "../../infrastructure/auth/solana-agent-auth.js";
import { getAuthRateLimit } from "../../infrastructure/rate-limit/rate-limit-config.js";
import { createDistributedRateLimitPreHandler } from "../../infrastructure/rate-limit/distributed-rate-limit.js";
import { isLocalDiagnosticDuelRuntime } from "../../systems/StreamingDuelScheduler/managers/DuelOrchestrator.js";

// Command acknowledgment delay (ms) - allows plugin to process before response
const COMMAND_ACK_DELAY_MS = 100;
const AGENT_MAPPING_CACHE_TTL_MS = 5000;

type AgentRouteCharacterRecord = {
  accountId: string;
  id: string;
  name: string;
};

type AgentMappingRecord = {
  accountId: string;
  agentId: string;
  agentName: string;
  characterId: string;
  streamingDuelEnabled?: boolean;
};

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type AgentRouteDb = {
  delete: (table: unknown) => {
    where: (condition: unknown) => Promise<unknown>;
  };
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => {
      onConflictDoUpdate: (config: {
        set: Record<string, unknown>;
        target: unknown;
      }) => Promise<unknown>;
    } & Promise<unknown>;
  };
  query: {
    characters: {
      findFirst: (opts: {
        where: (
          chars: { accountId: unknown; id: unknown },
          ops: { eq: (a: unknown, b: string) => unknown },
        ) => unknown;
      }) => Promise<AgentRouteCharacterRecord | null>;
    };
  };
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<unknown[]>;
    };
  };
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
};

type AgentRouteDatabaseSystem = {
  db?: AgentRouteDb;
  getCharactersAsync?: (
    accountId: string,
  ) => Promise<Array<{ id: string; name: string }>>;
  getDb?: () => AgentRouteDb | undefined;
  getPool?: () =>
    Pick<import("pg").Pool, "connect" | "query"> | null | undefined;
};

/**
 * Register agent credential routes
 *
 * Endpoints:
 * - POST /api/agents/credentials - Generate 7-day JWT for agent character
 *
 * @param fastify - Fastify server instance
 * @param world - Game world instance (for database access)
 */
export function registerAgentRoutes(
  fastify: FastifyInstance,
  world: World,
): void {
  console.log("[AgentRoutes] Registering agent credential routes...");

  const getVerifiedUserId = async (
    request: FastifyRequest,
  ): Promise<string | null> => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);
    const { verifyJWT } = await import("../../shared/utils.js");
    const { verifyPrivyToken, isPrivyEnabled } =
      await import("../../infrastructure/auth/privy-auth.js");

    // Try Privy token verification first (if enabled)
    if (isPrivyEnabled()) {
      try {
        const privyInfo = await verifyPrivyToken(token);
        if (privyInfo?.privyUserId) {
          return privyInfo.privyUserId;
        }
      } catch {
        // Fall through to JWT verification
      }
    }

    const jwtPayload = await verifyJWT(token);
    if (jwtPayload && jwtPayload.userId) {
      if (jwtPayload.isAgent === true) {
        const pool = getDatabasePool();
        if (!pool) return null;
        try {
          const session = await verifyAgentCredentialSession(jwtPayload, pool);
          if (!session) return null;
        } catch {
          return null;
        }
      } else {
        const pool = getDatabasePool();
        if (pool) {
          try {
            const result = await pool.query<{ roles: string }>(
              `SELECT "roles" FROM "users" WHERE "id" = $1`,
              [String(jwtPayload.userId)],
            );
            if (
              result.rows[0]?.roles
                .split(",")
                .map((role) => role.trim())
                .includes("agent")
            ) {
              return null;
            }
          } catch {
            return null;
          }
        }
      }
      return String(jwtPayload.userId);
    }

    return null;
  };

  const agentMappingByIdCache = new Map<
    string,
    CachedValue<AgentMappingRecord | null>
  >();
  const agentMappingsByAccountCache = new Map<
    string,
    CachedValue<AgentMappingRecord[]>
  >();
  const schemaModulePromise = import("../../database/schema.js");
  const drizzleModulePromise = import("drizzle-orm");
  const elizaIndexModulePromise = import("../../eliza/index.js");

  const getDatabaseSystem = (): AgentRouteDatabaseSystem | undefined =>
    world.getSystem("database") as AgentRouteDatabaseSystem | undefined;

  const getDatabaseDb = (): AgentRouteDb | null => {
    const databaseSystem = getDatabaseSystem();
    return databaseSystem?.db ?? databaseSystem?.getDb?.() ?? null;
  };

  const getDatabasePool = () => getDatabaseSystem()?.getPool?.() ?? null;

  const distributedAuthRateLimit = (scope: string) =>
    createDistributedRateLimitPreHandler({
      getPool: getDatabasePool,
      max: 5,
      scope,
      windowMs: 60_000,
    });

  const disconnectRevokedCredentialSessions = (
    sessionIds: readonly string[],
  ): number => {
    if (sessionIds.length === 0) return 0;
    const revoked = new Set(sessionIds);
    const network = world.getSystem("network") as
      | {
          sockets?: Map<
            string,
            {
              agentCredentialSessionId?: string;
              disconnect: (reason?: string) => void;
              send?: (name: string, data: unknown) => void;
            }
          >;
        }
      | undefined;
    if (!network?.sockets) return 0;

    let disconnected = 0;
    for (const socket of network.sockets.values()) {
      if (
        !socket.agentCredentialSessionId ||
        !revoked.has(socket.agentCredentialSessionId)
      ) {
        continue;
      }
      try {
        socket.send?.("kick", "agent_credentials_rotated");
      } finally {
        socket.disconnect("agent_credentials_rotated");
      }
      disconnected += 1;
    }
    return disconnected;
  };

  const createAgentCredentialToken = async (
    session: AgentCredentialSession,
    additionalClaims: Record<string, unknown> = {},
  ): Promise<string> =>
    createJWT(
      buildAgentCredentialJwtPayload(
        {
          accountId: session.accountId,
          authMethod: session.authMethod,
          characterId: session.characterId,
          expiresAt: session.expiresAt,
          sessionId: session.sessionId,
        },
        additionalClaims,
      ),
    );

  const requireOwnedAgentMutation = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const userId = await getVerifiedUserId(request);
    if (!userId) {
      await reply.status(401).send({
        success: false,
        error: "Unauthorized",
      });
      return;
    }
    const params = request.params as {
      agentId?: string;
      characterId?: string;
    };
    const routeId = params.agentId ?? params.characterId;
    const db = getDatabaseDb();
    if (!routeId || !db) {
      await reply.status(500).send({
        success: false,
        error: "Agent ownership authority not available",
      });
      return;
    }
    const mapping =
      (await getAgentMappingById(db, routeId, true)) ??
      (await getAgentMappingByCharacterId(db, routeId));
    if (!mapping || mapping.accountId !== userId) {
      await reply.status(403).send({
        success: false,
        error: "Forbidden",
      });
    }
  };

  const executeDisruptiveAgentMutation = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    mutate: (mapping: AgentMappingRecord) => Promise<T>,
    deleteMappingAfterMutation = false,
  ): Promise<{ mapping: AgentMappingRecord; value: T } | null> => {
    const userId = await getVerifiedUserId(request);
    const params = request.params as {
      agentId?: string;
      characterId?: string;
    };
    const routeAgentId = params.agentId ?? params.characterId;
    const pool = getDatabasePool();
    if (!userId || !routeAgentId || !pool) {
      await reply.status(500).send({
        success: false,
        error: "Transactional agent mutation authority not available",
      });
      return null;
    }
    const result = await executeOwnedAgentMutation({
      pool,
      routeAgentId,
      accountId: userId,
      deleteMappingAfterMutation,
      mutate,
    });
    if (result.status === "forbidden") {
      await reply.status(403).send({
        success: false,
        error: "Forbidden",
      });
      return null;
    }
    if (result.status === "market_locked") {
      await reply.status(409).send({
        success: false,
        error: "Agent mutation is locked until active duel cleanup completes",
      });
      return null;
    }
    return { mapping: result.mapping, value: result.value };
  };

  const getCachedValue = <T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
  ): T | undefined => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  };

  const setCachedValue = <T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
    value: T,
  ): void => {
    cache.set(key, {
      expiresAt: Date.now() + AGENT_MAPPING_CACHE_TTL_MS,
      value,
    });
  };

  const primeAgentMappingCache = (mapping: AgentMappingRecord): void => {
    setCachedValue(agentMappingByIdCache, mapping.agentId, mapping);
    const cachedAccountMappings = getCachedValue(
      agentMappingsByAccountCache,
      mapping.accountId,
    );
    if (cachedAccountMappings) {
      const nextMappings = cachedAccountMappings.filter(
        (candidate) => candidate.agentId !== mapping.agentId,
      );
      nextMappings.push(mapping);
      setCachedValue(
        agentMappingsByAccountCache,
        mapping.accountId,
        nextMappings,
      );
    }
  };

  const invalidateAgentMappingCache = (
    agentId: string,
    ...accountIds: Array<string | undefined>
  ): void => {
    const cachedMapping = agentMappingByIdCache.get(agentId)?.value;
    agentMappingByIdCache.delete(agentId);

    const accountsToInvalidate = new Set<string>();
    if (cachedMapping?.accountId) {
      accountsToInvalidate.add(cachedMapping.accountId);
    }
    for (const accountId of accountIds) {
      if (accountId) {
        accountsToInvalidate.add(accountId);
      }
    }

    for (const accountId of accountsToInvalidate) {
      agentMappingsByAccountCache.delete(accountId);
    }
  };

  const listAgentMappingsByAccount = async (
    db: AgentRouteDb,
    accountId: string,
  ): Promise<AgentMappingRecord[]> => {
    const cachedMappings = getCachedValue(
      agentMappingsByAccountCache,
      accountId,
    );
    if (cachedMappings) {
      return cachedMappings;
    }

    const { agentMappings } = await schemaModulePromise;
    const { eq } = await drizzleModulePromise;
    const mappings = (await db
      .select()
      .from(agentMappings)
      .where(eq(agentMappings.accountId, accountId))) as AgentMappingRecord[];

    setCachedValue(agentMappingsByAccountCache, accountId, mappings);
    for (const mapping of mappings) {
      setCachedValue(agentMappingByIdCache, mapping.agentId, mapping);
    }

    return mappings;
  };

  const getAgentMappingById = async (
    db: AgentRouteDb,
    agentId: string,
    bypassCache = false,
  ): Promise<AgentMappingRecord | null> => {
    if (!bypassCache) {
      const cachedMapping = getCachedValue(agentMappingByIdCache, agentId);
      if (cachedMapping !== undefined) {
        return cachedMapping;
      }
    }

    const { agentMappings } = await schemaModulePromise;
    const { eq } = await drizzleModulePromise;
    const mappings = (await db
      .select()
      .from(agentMappings)
      .where(eq(agentMappings.agentId, agentId))) as AgentMappingRecord[];
    const mapping = mappings[0] ?? null;

    setCachedValue(agentMappingByIdCache, agentId, mapping);
    if (mapping) {
      const cachedAccountMappings = getCachedValue(
        agentMappingsByAccountCache,
        mapping.accountId,
      );
      if (cachedAccountMappings) {
        const nextMappings = cachedAccountMappings.filter(
          (candidate) => candidate.agentId !== mapping.agentId,
        );
        nextMappings.push(mapping);
        setCachedValue(
          agentMappingsByAccountCache,
          mapping.accountId,
          nextMappings,
        );
      }
    }

    return mapping;
  };

  const getAgentMappingByCharacterId = async (
    db: AgentRouteDb,
    characterId: string,
  ): Promise<AgentMappingRecord | null> => {
    const { agentMappings } = await schemaModulePromise;
    const { eq } = await drizzleModulePromise;
    const mappings = (await db
      .select()
      .from(agentMappings)
      .where(
        eq(agentMappings.characterId, characterId),
      )) as AgentMappingRecord[];
    return mappings[0] ?? null;
  };

  /**
   * Resolve dashboard / Eliza route param to embedded agent characterId.
   * Accepts either Hyperia character UUID or stored mapping agent_id (e.g. Eliza id).
   */
  const resolveDashboardAgentCharacterId = async (
    routeAgentId: string,
  ): Promise<string | null> => {
    const { getAgentManager, getRunningAgents } = await elizaIndexModulePromise;
    const agentManager = getAgentManager();
    if (agentManager?.getAgentInfo(routeAgentId)) {
      return routeAgentId;
    }

    const db = getDatabaseDb();
    if (db) {
      const byAgentKey = await getAgentMappingById(db, routeAgentId);
      if (byAgentKey?.characterId) {
        return byAgentKey.characterId;
      }
      const byCharacter = await getAgentMappingByCharacterId(db, routeAgentId);
      if (byCharacter?.characterId) {
        return byCharacter.characterId;
      }
    }

    const runningModelAgents = getRunningAgents() as Map<
      string,
      { characterId: string }
    >;
    for (const [, runningAgent] of runningModelAgents) {
      if (runningAgent.characterId === routeAgentId) {
        return routeAgentId;
      }
    }

    return null;
  };

  const getRunningModelAgentMapping = async (
    agentId: string,
  ): Promise<AgentMappingRecord | null> => {
    const { getRunningAgents } = await elizaIndexModulePromise;
    const runningModelAgents = getRunningAgents() as Map<
      string,
      {
        accountId: string;
        characterId: string;
        config: { displayName: string };
      }
    >;

    for (const [, runningAgent] of runningModelAgents) {
      if (runningAgent.characterId === agentId) {
        return {
          accountId: runningAgent.accountId,
          agentId,
          agentName: runningAgent.config.displayName,
          characterId: runningAgent.characterId,
        };
      }
    }

    return null;
  };

  const resolveAgentCharacterId = async (
    db: AgentRouteDb,
    agentId: string,
    allowAgentManagerFallback = false,
  ): Promise<string | null> => {
    const mapping = await getAgentMappingById(db, agentId);
    if (mapping?.characterId) {
      return mapping.characterId;
    }
    if (!allowAgentManagerFallback) {
      return null;
    }

    const { getAgentManager } = await elizaIndexModulePromise;
    const agentManager = getAgentManager();
    const embeddedAgent = agentManager?.getAgentInfo(agentId);
    return embeddedAgent?.characterId ?? null;
  };

  /**
   * POST /api/agents/credentials
   *
   * Generate authentication credentials for an AI agent character.
   * This endpoint creates a 7-day Hyperia JWT,
   * allowing the agent to connect autonomously.
   *
   * Request body:
   * {
   *   characterId: "character-uuid",
   *   accountId: "privy-user-id"
   * }
   *
   * Response:
   * {
   *   success: true,
   *   authToken: "7-day-jwt-token",
   *   characterId: "character-uuid",
   *   serverUrl: "ws://localhost:5556/ws"
   * }
   */
  fastify.post(
    "/api/agents/credentials",
    {
      config: { rateLimit: getAuthRateLimit() },
      preHandler: distributedAuthRateLimit("agent-credentials-issue"),
    },
    async (request, reply) => {
      try {
        const body = request.body as {
          characterId: string;
          accountId: string;
        };

        if (!body.characterId || !body.accountId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required fields: characterId, accountId",
          });
        }

        const { characterId, accountId } = body;

        const verifiedUserId = await getVerifiedUserId(request);
        if (!verifiedUserId) {
          return reply.status(401).send({
            success: false,
            error: "Unauthorized",
          });
        }
        if (verifiedUserId !== accountId) {
          return reply.status(403).send({
            success: false,
            error: "Forbidden",
          });
        }

        console.log("[AgentRoutes] Generating credentials for:", {
          characterId,
          accountId,
        });

        // Verify character exists and belongs to this account
        const databaseSystem = world.getSystem("database") as
          | {
              getCharactersAsync: (
                accountId: string,
              ) => Promise<Array<{ id: string; name: string }>>;
            }
          | undefined;

        if (!databaseSystem) {
          console.error("[AgentRoutes] DatabaseSystem not available");
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characters = await databaseSystem.getCharactersAsync(accountId);
        const character = characters.find((c) => c.id === characterId);

        if (!character) {
          console.warn(
            `[AgentRoutes] Character ${characterId} not found or not owned by ${accountId}`,
          );
          return reply.status(403).send({
            success: false,
            error: "Character not found or access denied",
          });
        }

        console.log("[AgentRoutes] Character verified:", character.name);

        const pool = getDatabasePool();
        if (!pool) {
          return reply.status(503).send({
            success: false,
            error: "Agent credential authority not available",
          });
        }
        const credentialSession = await rotateAgentCredentialSession({
          accountId,
          authMethod: "owner-credential-v1",
          characterId,
          pool,
        });
        disconnectRevokedCredentialSessions(
          credentialSession.revokedSessionIds,
        );
        const authToken = await createAgentCredentialToken(credentialSession);

        console.log(
          `[AgentRoutes] ✅ Generated 7-day JWT for agent: ${character.name}`,
        );

        // Get server URL from environment or use default
        const serverUrl =
          process.env.HYPERIA_SERVER_URL ||
          process.env.PUBLIC_WS_URL ||
          getDefaultPublicWsUrl();

        return reply.send({
          success: true,
          authToken,
          characterId,
          serverUrl,
          message: `Credentials generated for ${character.name} (expires in 7 days)`,
        });
      } catch (error) {
        if (error instanceof AgentCredentialSessionRejectedError) {
          return reply.status(403).send({
            success: false,
            error: "Character not found or access denied",
          });
        }
        console.error(
          "[AgentRoutes] ❌ Failed to generate credentials:",
          error instanceof Error ? error.message : "unknown error",
        );

        return reply.status(503).send({
          success: false,
          error: "Agent credential authority not available",
        });
      }
    },
  );

  fastify.delete(
    "/api/agents/credentials/:characterId",
    {
      config: { rateLimit: getAuthRateLimit() },
      preHandler: distributedAuthRateLimit("agent-credentials-revoke"),
    },
    async (request, reply) => {
      const userId = await getVerifiedUserId(request);
      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      const characterId = (request.params as { characterId?: unknown })
        ?.characterId;
      if (
        typeof characterId !== "string" ||
        characterId.length < 1 ||
        characterId.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(characterId)
      ) {
        return reply.status(400).send({
          success: false,
          error: "Invalid characterId",
        });
      }
      const pool = getDatabasePool();
      if (!pool) {
        return reply.status(503).send({
          success: false,
          error: "Agent credential authority not available",
        });
      }

      try {
        const revokedSessionIds = await revokeAgentCredentialSessions({
          accountId: userId,
          characterId,
          pool,
        });
        const disconnectedSocketCount =
          disconnectRevokedCredentialSessions(revokedSessionIds);
        return reply.send({
          success: true,
          disconnectedSocketCount,
          revokedSessionCount: revokedSessionIds.length,
        });
      } catch (error) {
        if (error instanceof AgentCredentialSessionRejectedError) {
          return reply.status(403).send({
            success: false,
            error: "Character not found or access denied",
          });
        }
        console.error(
          "[AgentRoutes] Failed to revoke agent credentials:",
          error instanceof Error ? error.message : "unknown error",
        );
        return reply.status(503).send({
          success: false,
          error: "Agent credential authority not available",
        });
      }
    },
  );

  fastify.get(
    "/api/agents/credentials/status",
    {
      config: { rateLimit: getAuthRateLimit() },
      preHandler: distributedAuthRateLimit("agent-credentials-status"),
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.status(401).send({
          success: false,
          active: false,
          error: "Unauthorized",
        });
      }

      const pool = getDatabasePool();
      if (!pool) {
        return reply.status(503).send({
          success: false,
          active: false,
          error: "Agent credential authority not available",
        });
      }

      const { verifyJWT } = await import("../../shared/utils.js");
      const jwtPayload = await verifyJWT(authHeader.slice(7));
      if (!jwtPayload || jwtPayload.isAgent !== true) {
        return reply.status(401).send({
          success: false,
          active: false,
          error: "Unauthorized",
        });
      }

      try {
        const session = await verifyAgentCredentialSession(jwtPayload, pool);
        if (!session) {
          return reply.status(401).send({
            success: false,
            active: false,
            error: "Unauthorized",
          });
        }
      } catch {
        return reply.status(503).send({
          success: false,
          active: false,
          error: "Agent credential authority not available",
        });
      }

      return reply.send({
        success: true,
        active: true,
      });
    },
  );

  const readSolanaAuthConfigForRequest = (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const config = readSolanaAgentAuthConfig(process.env);
      if (!config) {
        reply.status(404).send({ success: false, error: "Not found" });
        return null;
      }
      if (
        !requestMatchesSolanaAgentAuthConfig(
          config,
          request.headers as Record<string, unknown>,
        )
      ) {
        reply.status(403).send({ success: false, error: "Forbidden" });
        return null;
      }
      return config;
    } catch (error) {
      if (error instanceof SolanaAgentAuthConfigurationError) {
        console.error(
          "[AgentRoutes] SOL agent authentication configuration is invalid:",
          error.message,
        );
        reply.status(503).send({
          success: false,
          error: "Wallet authentication is unavailable",
        });
        return null;
      }
      throw error;
    }
  };

  fastify.post(
    "/api/agents/sol-wallet-auth/challenge",
    {
      config: { rateLimit: getAuthRateLimit() },
      preHandler: distributedAuthRateLimit("sol-agent-challenge"),
    },
    async (request, reply) => {
      const config = readSolanaAuthConfigForRequest(request, reply);
      if (!config) return;

      try {
        const body = request.body as {
          agentName?: unknown;
          characterId?: unknown;
          walletAddress?: unknown;
        };
        const walletAddress = canonicalizeSolanaWalletAddress(
          body?.walletAddress,
        );
        const agentName = normalizeSolanaAgentName(
          body?.agentName,
          walletAddress,
        );
        const characterId = normalizeRequestedCharacterId(body?.characterId);
        const pool = getDatabasePool();
        if (!pool) {
          return reply.status(503).send({
            success: false,
            error: "Wallet authentication is unavailable",
          });
        }

        const challenge = await issueSolanaAgentAuthChallenge({
          agentName,
          characterId,
          config,
          pool,
          walletAddress,
        });
        return reply.send({
          success: true,
          ...challenge,
        });
      } catch (error) {
        if (error instanceof SolanaAgentAuthRateLimitError) {
          return reply.status(429).send({
            success: false,
            error: "Too many wallet authentication challenges",
          });
        }
        if (error instanceof SolanaAgentAuthInputError) {
          return reply.status(400).send({
            success: false,
            error: error.message,
          });
        }
        console.error(
          "[AgentRoutes] Failed to issue SOL wallet authentication challenge:",
          error instanceof Error ? error.message : "unknown error",
        );
        return reply.status(500).send({
          success: false,
          error: "Failed to issue wallet authentication challenge",
        });
      }
    },
  );

  fastify.post(
    "/api/agents/sol-wallet-auth/verify",
    {
      config: { rateLimit: getAuthRateLimit() },
      preHandler: distributedAuthRateLimit("sol-agent-verify"),
    },
    async (request, reply) => {
      const config = readSolanaAuthConfigForRequest(request, reply);
      if (!config) return;

      try {
        const body = request.body as {
          challengeId?: unknown;
          message?: unknown;
          signature?: unknown;
          walletAddress?: unknown;
        };
        if (
          typeof body?.challengeId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            body.challengeId,
          ) ||
          typeof body.message !== "string" ||
          body.message.length < 1 ||
          body.message.length > 4096 ||
          typeof body.signature !== "string" ||
          body.signature.length < 1 ||
          body.signature.length > 128
        ) {
          return reply.status(400).send({
            success: false,
            error: "Invalid wallet authentication payload",
          });
        }
        const walletAddress = canonicalizeSolanaWalletAddress(
          body.walletAddress,
        );
        const pool = getDatabasePool();
        if (!pool) {
          return reply.status(503).send({
            success: false,
            error: "Wallet authentication is unavailable",
          });
        }

        const identity = await verifyAndConsumeSolanaAgentAuthChallenge({
          challengeId: body.challengeId,
          config,
          message: body.message,
          pool,
          signature: body.signature,
          walletAddress,
        });
        disconnectRevokedCredentialSessions(
          identity.credentialSession.revokedSessionIds,
        );
        const authToken = await createAgentCredentialToken(
          identity.credentialSession,
          {
            walletAddress: identity.walletAddress,
            walletType: "solana",
          },
        );
        const serverUrl =
          process.env.HYPERIA_SERVER_URL ||
          process.env.PUBLIC_WS_URL ||
          getDefaultPublicWsUrl();

        return reply.send({
          success: true,
          accountId: identity.accountId,
          authToken,
          characterId: identity.characterId,
          serverUrl,
          walletAddress: identity.walletAddress,
        });
      } catch (error) {
        if (error instanceof SolanaAgentAuthRejectedError) {
          return reply.status(401).send({
            success: false,
            error: "Wallet authentication failed",
          });
        }
        if (error instanceof SolanaAgentAuthProvisioningError) {
          return reply.status(409).send({
            success: false,
            code: error.code,
            error: error.message,
          });
        }
        if (error instanceof SolanaAgentAuthInputError) {
          return reply.status(400).send({
            success: false,
            error: error.message,
          });
        }
        console.error(
          "[AgentRoutes] SOL wallet authentication failed:",
          error instanceof Error ? error.message : "unknown error",
        );
        return reply.status(500).send({
          success: false,
          error: "Wallet authentication failed",
        });
      }
    },
  );

  /**
   * POST /api/agents/wallet-auth
   *
   * Diagnostic-only address compatibility for local no-money agent fixtures.
   * Production SOL agents must use the challenge/signature routes above.
   * Auto-creates user account and character if they don't exist.
   * If agentId is provided, also creates agent mapping for dashboard spectating.
   *
   * Request body:
   * {
   *   walletAddress: "canonical base58 SOL address",
   *   walletType?: "solana",
   *   agentName?: "optional name",
   *   agentId?: "eliza-agent-uuid" (for dashboard spectating)
   * }
   *
   * Response:
   * {
   *   success: true,
   *   authToken: "7-day-jwt",
   *   characterId: "character-uuid",
   *   accountId: "wallet-address",
   *   serverUrl: "ws://..."
   * }
   */
  fastify.post("/api/agents/wallet-auth", async (request, reply) => {
    try {
      if (!isLocalDiagnosticDuelRuntime(process.env)) {
        return reply.status(404).send({
          success: false,
          error: "Not found",
        });
      }
      const body = request.body as {
        walletAddress: string;
        walletType?: "solana";
        agentName?: string;
        agentId?: string;
      };

      if (
        !body.walletAddress ||
        (body.walletType && body.walletType !== "solana")
      ) {
        return reply.status(400).send({
          success: false,
          error: "A canonical SOL walletAddress is required",
        });
      }

      const walletAddress = canonicalizeSolanaWalletAddress(body.walletAddress);
      const walletType = "solana" as const;
      const agentName = normalizeSolanaAgentName(body.agentName, walletAddress);
      const agentId = body.agentId?.trim();
      if (
        agentId &&
        (agentId.length > 128 || /[\u0000-\u001f\u007f]/u.test(agentId))
      ) {
        throw new SolanaAgentAuthInputError("agentId is invalid");
      }

      console.log("[AgentRoutes] Wallet auth request:", {
        walletAddress: walletAddress.slice(0, 10) + "...",
        walletType,
        agentName,
        agentId: agentId ? `${agentId.slice(0, 8)}...` : "not provided",
      });

      // Use wallet address as account ID (prefixed for clarity)
      const accountId = `wallet:${walletType}:${walletAddress}`;

      // Get database access
      const databaseSystem = world.getSystem("database") as
        | {
            db: {
              select: (fields?: unknown) => {
                from: (table: unknown) => {
                  where: (condition: unknown) => Promise<unknown[]>;
                };
              };
              insert: (table: unknown) => {
                values: (values: Record<string, unknown>) => {
                  onConflictDoUpdate: (config: {
                    target: unknown;
                    set: unknown;
                  }) => Promise<unknown>;
                } & Promise<unknown>;
              };
              query: {
                characters: {
                  findFirst: (opts: {
                    where: (
                      chars: { accountId: unknown },
                      ops: { eq: (a: unknown, b: string) => unknown },
                    ) => unknown;
                  }) => Promise<{ id: string; name: string } | null>;
                };
              };
            };
          }
        | undefined;

      if (!databaseSystem?.db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const { users, characters, agentMappings } =
        await import("../../database/schema.js");
      const { eq } = await import("drizzle-orm");

      // Check if user exists, create if not
      const existingUsers = (await databaseSystem.db
        .select()
        .from(users)
        .where(eq(users.id, accountId))) as Array<{ id: string }>;

      if (existingUsers.length === 0) {
        console.log(`[AgentRoutes] Creating new wallet user: ${accountId}`);
        await databaseSystem.db.insert(users).values({
          id: accountId,
          name: agentName,
          roles: "player",
          createdAt: new Date().toISOString(),
        });
      }

      // Check if character exists for this wallet, create if not
      let character = await databaseSystem.db.query.characters.findFirst({
        where: (chars, ops) => ops.eq(chars.accountId, accountId),
      });

      if (!character) {
        const characterId = `char-${walletAddress.slice(0, 16)}-${Date.now()}`;
        console.log(`[AgentRoutes] Creating new character: ${characterId}`);

        await databaseSystem.db.insert(characters).values({
          id: characterId,
          accountId: accountId,
          name: agentName,
          isAgent: 1,
          wallet: walletAddress,
          createdAt: Date.now(),
        });

        character = { id: characterId, name: agentName };
      }

      const pool = getDatabasePool();
      if (!pool) {
        return reply.status(503).send({
          success: false,
          error: "Agent credential authority not available",
        });
      }
      const credentialSession = await rotateAgentCredentialSession({
        accountId,
        authMethod: "local-diagnostic-wallet-v1",
        characterId: character.id,
        pool,
      });
      disconnectRevokedCredentialSessions(credentialSession.revokedSessionIds);
      const authToken = await createAgentCredentialToken(credentialSession, {
        walletAddress,
        walletType,
      });

      const serverUrl =
        process.env.HYPERIA_SERVER_URL ||
        process.env.PUBLIC_WS_URL ||
        getDefaultPublicWsUrl();

      // If agentId was provided, create/update agent mapping for dashboard spectating
      if (agentId) {
        try {
          const existingMapping = await getAgentMappingById(
            databaseSystem.db as AgentRouteDb,
            agentId,
            true,
          );
          await databaseSystem.db
            .insert(agentMappings)
            .values({
              agentId,
              accountId,
              characterId: character.id,
              agentName,
              streamingDuelEnabled: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: agentMappings.agentId,
              set: {
                accountId,
                characterId: character.id,
                agentName,
                updatedAt: new Date(),
              },
            });
          invalidateAgentMappingCache(
            agentId,
            existingMapping?.accountId,
            accountId,
          );
          primeAgentMappingCache({
            agentId,
            accountId,
            characterId: character.id,
            agentName,
            streamingDuelEnabled:
              existingMapping?.streamingDuelEnabled === true,
          });
          console.log(
            `[AgentRoutes] ✅ Agent mapping created for dashboard spectating: ${agentId}`,
          );
        } catch (mappingError) {
          // Log but don't fail auth if mapping fails
          console.warn(
            `[AgentRoutes] ⚠️ Failed to create agent mapping (non-fatal): ${mappingError}`,
          );
        }
      }

      console.log(
        `[AgentRoutes] ✅ Wallet auth successful: ${agentName} (${character.id})`,
      );

      return reply.send({
        success: true,
        authToken,
        characterId: character.id,
        accountId,
        walletAddress,
        serverUrl,
        agentId: agentId || undefined,
        message: `Authenticated as ${agentName} (expires in 7 days)`,
      });
    } catch (error) {
      if (error instanceof SolanaAgentAuthInputError) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }
      console.error("[AgentRoutes] ❌ Wallet auth failed:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Wallet auth failed",
      });
    }
  });

  /**
   * GET /api/agents/mappings/:accountId
   *
   * Get all agent mappings for a user.
   * Returns the list of agent IDs owned by this user.
   *
   * Response:
   * {
   *   success: true,
   *   agentIds: ["agent-id-1", "agent-id-2", ...]
   * }
   */
  fastify.get("/api/agents/mappings/:accountId", async (request, reply) => {
    try {
      const params = request.params as { accountId: string };
      const { accountId } = params;

      if (!accountId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required parameter: accountId",
        });
      }

      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      if (verifiedUserId !== accountId) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
      }

      console.log("[AgentRoutes] Fetching agent mappings for:", accountId);

      const db = getDatabaseDb();
      if (!db) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Database system not available",
        });
      }

      const mappings = await listAgentMappingsByAccount(db, accountId);

      const agentIds = mappings.flatMap((m) => [m.agentId, m.characterId]);

      // Model duel agents are public streaming participants; include them in
      // mapping lookup so dashboards can discover live duel roster.
      const { getRunningAgents } = await import("../../eliza/index.js");
      const runningModelAgents = getRunningAgents() as Map<
        string,
        {
          characterId: string;
        }
      >;

      for (const [, runningAgent] of runningModelAgents) {
        if (runningAgent.characterId) {
          agentIds.push(runningAgent.characterId);
        }
      }

      const uniqueAgentIds = Array.from(new Set(agentIds));

      console.log(
        `[AgentRoutes] Found ${uniqueAgentIds.length} agent(s) for ${accountId}`,
      );

      return reply.send({
        success: true,
        agentIds: uniqueAgentIds,
        count: uniqueAgentIds.length,
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to fetch agent mappings:", error);

      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch agent mappings",
      });
    }
  });

  /**
   * POST /api/agents/mappings
   *
   * Save agent-to-user mapping for dashboard filtering.
   * This allows the dashboard to show only agents owned by the current user.
   *
   * Request body:
   * {
   *   agentId: "eliza-agent-uuid",
   *   accountId: "privy-user-id",
   *   characterId: "character-uuid",
   *   agentName: "Agent Name"
   * }
   *
   * Response:
   * {
   *   success: true
   * }
   */
  fastify.post("/api/agents/mappings", async (request, reply) => {
    try {
      const body = request.body as {
        agentId: string;
        accountId: string;
        characterId: string;
        agentName: string;
      };

      if (
        !body.agentId ||
        !body.accountId ||
        !body.characterId ||
        !body.agentName
      ) {
        return reply.status(400).send({
          success: false,
          error:
            "Missing required fields: agentId, accountId, characterId, agentName",
        });
      }

      const { agentId, accountId, characterId, agentName } = body;

      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      if (verifiedUserId !== accountId) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
      }

      console.log("[AgentRoutes] Saving agent mapping:", {
        agentId,
        accountId,
        characterId,
        agentName,
      });

      const pool = getDatabasePool();
      if (!pool) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Transactional database authority not available",
        });
      }

      const saved = await savePersistedAgentMapping({
        pool,
        agentId,
        accountId,
        characterId,
        agentName,
      });
      if (saved.status === "character_forbidden") {
        return reply.status(403).send({
          success: false,
          error: "Character not found or access denied",
        });
      }
      if (saved.status === "mapping_conflict") {
        return reply.status(409).send({
          success: false,
          error: "Agent or character is already mapped",
        });
      }
      invalidateAgentMappingCache(agentId, saved.mapping.accountId);
      primeAgentMappingCache(saved.mapping);

      console.log(`[AgentRoutes] ✅ Agent mapping saved for: ${agentName}`);

      return reply.send({
        success: true,
        message: `Agent mapping saved for ${agentName}`,
        streamingDuelEnabled: saved.mapping.streamingDuelEnabled,
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to save agent mapping:", error);

      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to save agent mapping",
      });
    }
  });

  /**
   * GET /api/agents/mapping/:agentId
   *
   * Get a single agent mapping by agent ID.
   * Returns the character ID and other details for this agent.
   * Used by dashboard viewport to get character ID for iframe embedding.
   *
   * Response:
   * {
   *   success: true,
   *   agentId: "agent-uuid",
   *   characterId: "character-uuid",
   *   accountId: "privy-user-id",
   *   agentName: "Agent Name"
   * }
   */
  fastify.get(
    "/api/agents/mapping/:agentId",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        console.log("[AgentRoutes] Fetching mapping for agent:", agentId);

        const db = getDatabaseDb();
        if (!db) {
          console.error("[AgentRoutes] DatabaseSystem not available");
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const mapping = await getAgentMappingById(db, agentId);
        if (!mapping) {
          const runningAgentMapping =
            await getRunningModelAgentMapping(agentId);
          if (runningAgentMapping) {
            return reply.send({
              success: true,
              agentId,
              characterId: runningAgentMapping.characterId,
              accountId: runningAgentMapping.accountId,
              agentName: runningAgentMapping.agentName,
              streamingDuelEnabled: false,
            });
          }

          console.log(`[AgentRoutes] No mapping found for agent: ${agentId}`);
          return reply.status(404).send({
            success: false,
            error: "Agent mapping not found",
          });
        }

        console.log(
          `[AgentRoutes] ✅ Found mapping for agent ${agentId}: characterId=${mapping.characterId}`,
        );

        return reply.send({
          success: true,
          agentId: mapping.agentId,
          characterId: mapping.characterId,
          accountId: mapping.accountId,
          agentName: mapping.agentName,
          streamingDuelEnabled: mapping.streamingDuelEnabled === true,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to fetch agent mapping:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch agent mapping",
        });
      }
    },
  );

  /**
   * PATCH / POST /api/agents/mappings/:agentId/streaming-duel
   *
   * Toggle whether this agent participates in streaming duel arena matchmaking.
   * POST is registered alongside PATCH for clients/proxies that mishandle PATCH.
   */
  const handleStreamingDuelPreference = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      const userId = await getVerifiedUserId(request);
      if (!userId) {
        await reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
        return;
      }

      const params = request.params as { agentId: string };
      const { agentId } = params;
      const body = request.body as { streamingDuelEnabled?: boolean };

      if (!agentId || typeof body.streamingDuelEnabled !== "boolean") {
        await reply.status(400).send({
          success: false,
          error: "Missing agentId or streamingDuelEnabled (boolean)",
        });
        return;
      }

      const pool = getDatabasePool();
      if (!pool) {
        await reply.status(500).send({
          success: false,
          error: "Transactional database authority not available",
        });
        return;
      }

      const mutation = await updatePersistedStreamingDuelParticipation({
        pool,
        agentId,
        accountId: userId,
        enabled: body.streamingDuelEnabled,
      });
      if (mutation.status === "forbidden") {
        await reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
        return;
      }
      if (mutation.status === "market_locked") {
        await reply.status(409).send({
          success: false,
          error:
            "Streaming duel participation is locked until active duel cleanup completes",
        });
        return;
      }

      const updatedMapping = mutation.mapping;
      invalidateAgentMappingCache(agentId, updatedMapping.accountId);
      primeAgentMappingCache(updatedMapping);

      const { getStreamingDuelScheduler } =
        await import("../../systems/StreamingDuelScheduler/index.js");
      const scheduler = getStreamingDuelScheduler();
      const characterId = updatedMapping.characterId;
      // Matchmaking + world.entities use character (player) id, not dashboard mapping id.
      scheduler?.applyStreamingDuelParticipation(
        characterId,
        updatedMapping.streamingDuelEnabled,
      );

      await reply.send({
        success: true,
        agentId,
        characterId,
        streamingDuelEnabled: updatedMapping.streamingDuelEnabled,
      });
    } catch (error) {
      console.error(
        "[AgentRoutes] ❌ Failed to update streaming duel preference:",
        error,
      );
      await reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update preference",
      });
    }
  };

  fastify.patch(
    "/api/agents/mappings/:agentId/streaming-duel",
    handleStreamingDuelPreference,
  );
  fastify.post(
    "/api/agents/mappings/:agentId/streaming-duel",
    handleStreamingDuelPreference,
  );

  /**
   * DELETE /api/agents/mappings/:agentId
   *
   * Delete agent mapping from Hyperia database.
   * This removes the link between an ElizaOS agent and the user's account.
   *
   * Response:
   * {
   *   success: true,
   *   message: "Agent mapping deleted"
   * }
   */
  fastify.delete("/api/agents/mappings/:agentId", async (request, reply) => {
    try {
      const params = request.params as { agentId: string };
      const { agentId } = params;

      if (!agentId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required parameter: agentId",
        });
      }

      const userId = await getVerifiedUserId(request);
      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }

      console.log("[AgentRoutes] Deleting agent mapping for:", agentId);

      const pool = getDatabasePool();
      if (!pool) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Transactional database authority not available",
        });
      }

      const deletion = await deletePersistedStreamingDuelMapping({
        pool,
        agentId,
        accountId: userId,
      });
      if (deletion.status === "forbidden") {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
      }
      if (deletion.status === "market_locked") {
        return reply.status(409).send({
          success: false,
          error: "Agent mapping is locked until active duel cleanup completes",
        });
      }
      invalidateAgentMappingCache(agentId, deletion.mapping.accountId);

      const { getStreamingDuelScheduler } =
        await import("../../systems/StreamingDuelScheduler/index.js");
      getStreamingDuelScheduler()?.applyStreamingDuelParticipation(
        deletion.mapping.characterId,
        false,
      );

      console.log(`[AgentRoutes] ✅ Agent mapping deleted for: ${agentId}`);

      return reply.send({
        success: true,
        message: "Agent mapping deleted",
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to delete agent mapping:", error);

      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete agent mapping",
      });
    }
  });

  /**
   * POST /api/agents/:agentId/message
   *
   * Operator → agent chat: scripted intent (if matched) or LLM reply only.
   * Does not return synthetic “posted to chat” text — start the agent and fix model config instead.
   * SECURITY: User must own the agent (Bearer Privy or Hyperia JWT).
   */
  fastify.post("/api/agents/:agentId/message", async (request, reply) => {
    try {
      const params = request.params as { agentId: string };
      const body = request.body as {
        content: string;
      };

      const { agentId } = params;
      const { content } = body;

      const verifiedUserId = await getVerifiedUserId(request);

      if (!verifiedUserId) {
        console.warn("[AgentRoutes] ❌ Token verification failed");
        return reply.status(401).send({
          success: false,
          error: "Invalid or expired authentication token",
        });
      }

      if (!agentId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required parameter: agentId",
        });
      }

      if (!content) {
        return reply.status(400).send({
          success: false,
          error: "Missing required field: content",
        });
      }

      const db = getDatabaseDb();
      if (!db) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Database system not available",
        });
      }

      let mapping = await getAgentMappingById(db, agentId);
      if (!mapping) {
        mapping = await getAgentMappingByCharacterId(db, agentId);
      }
      if (!mapping) {
        console.warn(`[AgentRoutes] Agent ${agentId} not found in mappings`);
        return reply.status(404).send({
          success: false,
          error: "Agent not found",
        });
      }

      if (mapping.accountId !== verifiedUserId) {
        console.warn(
          `[AgentRoutes] ❌ SECURITY: User ${verifiedUserId} tried to message agent ${agentId} owned by ${mapping.accountId}`,
        );
        return reply.status(403).send({
          success: false,
          error: "You do not have permission to message this agent",
        });
      }

      const characterId = mapping.characterId;
      console.log(
        `[AgentRoutes] ✅ Ownership verified: ${verifiedUserId} owns agent ${mapping.agentName}`,
      );
      console.log(
        `[AgentRoutes] Found agent ${mapping.agentName} (character: ${characterId})`,
      );

      const { getAgentManager } = await elizaIndexModulePromise;
      const agentManager = getAgentManager();
      const hasEmbedded = agentManager?.hasAgent(characterId) ?? false;
      const embeddedAgent = agentManager?.getAgentInfo(characterId);
      const running = hasEmbedded && embeddedAgent?.state === "running";

      const service = agentManager?.getAgentService(characterId);
      let resolvedIntent: ReturnType<typeof resolveDashboardIntent> | null =
        null;
      if (running && service) {
        try {
          service.invalidateNearbyEntityCache();
          resolvedIntent = resolveDashboardIntent(content, service);
        } catch (intentErr) {
          const msg =
            intentErr instanceof Error ? intentErr.message : String(intentErr);
          console.warn(
            "[AgentRoutes] Dashboard intent resolution failed:",
            intentErr,
          );
          return reply.status(400).send({
            success: false,
            error: `Could not interpret operator message: ${msg}`,
          });
        }
      }

      if (resolvedIntent && running && agentManager) {
        try {
          await agentManager.sendCommand(
            characterId,
            resolvedIntent.command,
            resolvedIntent.data,
          );

          recordAgentThought(characterId, {
            type: "decision",
            content: resolvedIntent.thought,
            decisionPath: "scripted",
          });

          return reply.send({
            success: true,
            message: `Agent ${resolvedIntent.command} command queued`,
            text: resolvedIntent.text,
            meta: {
              delivery: "dashboard_command",
              source: "dashboard-command-bridge",
              execution: "command",
              command: resolvedIntent.command,
              targetName: resolvedIntent.targetName,
            },
          });
        } catch (cmdErr) {
          const msg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
          console.warn(
            "[AgentRoutes] Dashboard command dispatch failed:",
            cmdErr,
          );
          return reply.status(502).send({
            success: false,
            error: msg,
          });
        }
      }

      if (running && agentManager) {
        try {
          const generatedReply = await agentManager.generateDashboardChatReply(
            characterId,
            content,
          );

          if (generatedReply.ok) {
            const replyService = agentManager.getAgentService(characterId);
            let messageId: string | null = null;
            if (replyService) {
              try {
                messageId = await replyService.sendChatMessage(
                  generatedReply.text,
                );
              } catch (sendErr) {
                console.warn(
                  "[AgentRoutes] LLM reply ok but sendChatMessage failed (operator still sees text below):",
                  sendErr instanceof Error ? sendErr.message : String(sendErr),
                );
              }
            }
            return reply.send({
              success: true,
              message: "Agent replied",
              id: messageId,
              text: generatedReply.text,
              meta: {
                delivery: "world_chat",
                provider: generatedReply.provider,
                model: generatedReply.model,
                source: generatedReply.source,
              },
            });
          }

          console.warn(
            "[AgentRoutes] Dashboard LLM did not succeed:",
            generatedReply.code,
            generatedReply.message,
          );
          return reply.status(503).send({
            success: false,
            error: generatedReply.message,
            code: generatedReply.code,
          });
        } catch (llmErr) {
          const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
          console.warn("[AgentRoutes] Dashboard LLM failed:", llmErr);
          return reply.status(503).send({
            success: false,
            error: `LLM error: ${msg}`,
            code: "UNEXPECTED",
          });
        }
      }

      if (!hasEmbedded) {
        return reply.status(503).send({
          success: false,
          error:
            "Agent is not connected to the game server. Start the agent from the dashboard, then try again.",
        });
      }

      if (!running) {
        return reply.status(409).send({
          success: false,
          error:
            "Agent is not running. Start the agent to receive LLM replies in this chat.",
        });
      }

      return reply.status(500).send({
        success: false,
        error:
          "Unexpected state while generating an agent reply. If this persists, check server logs.",
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to send message to agent:", error);

      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to send message to agent",
      });
    }
  });

  /**
   * GET /api/agents/:agentId/chat
   *
   * Recent world chat lines spoken by the agent (for dashboard).
   */
  fastify.get("/api/agents/:agentId/chat", async (request, reply) => {
    try {
      const params = request.params as { agentId: string };
      const query = request.query as { limit?: string | number };
      const { agentId } = params;
      const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);

      if (!agentId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required parameter: agentId",
        });
      }

      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Invalid or missing authentication token",
        });
      }

      const db = getDatabaseDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database system not available",
        });
      }

      const mapping = await getAgentMappingById(db, agentId);
      if (!mapping) {
        return reply.status(404).send({
          success: false,
          error: "Agent not found",
        });
      }

      if (mapping.accountId !== verifiedUserId) {
        return reply.status(403).send({
          success: false,
          error: "You do not have permission to access this agent",
        });
      }

      const chatSystem = world.chat as
        | {
            serialize?: () => Array<{
              id: string;
              from: string;
              fromId?: string;
              body: string;
              text: string;
              timestamp: number;
              createdAt: string;
              type?: string;
            }>;
          }
        | undefined;

      const messages = (chatSystem?.serialize?.() || [])
        .filter((msg) => msg.fromId === mapping.characterId)
        .slice(-limit);

      return reply.send({
        success: true,
        data: {
          messages,
        },
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to get agent chat:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get agent chat",
      });
    }
  });

  /**
   * POST /api/spectator/token
   *
   * Exchange a Privy token for a 7-day spectator JWT.
   * This solves the issue where Privy tokens expire after ~1 hour,
   * causing spectator mode to lose authentication.
   *
   * SECURITY: Verifies Privy token and checks agent ownership before issuing JWT.
   *
   * Request body:
   * {
   *   agentId: "agent-uuid",
   *   privyToken: "privy-access-token"
   * }
   *
   * Response:
   * {
   *   success: true,
   *   spectatorToken: "7-day-jwt-token",
   *   characterId: "character-uuid",
   *   expiresAt: "ISO-8601 date"  // Token expires in 7 days
   * }
   */
  fastify.post("/api/spectator/token", async (request, reply) => {
    try {
      const body = request.body as {
        agentId: string;
        privyToken: string;
      };

      const { agentId, privyToken } = body;

      if (!agentId || !privyToken) {
        return reply.status(400).send({
          success: false,
          error: "Missing required fields: agentId, privyToken",
        });
      }

      // Verify the Privy token
      const { verifyPrivyToken, isPrivyEnabled } =
        await import("../../infrastructure/auth/privy-auth.js");

      if (!isPrivyEnabled()) {
        return reply.status(503).send({
          success: false,
          error: "Privy authentication is not configured on this server",
        });
      }

      let verifiedUserId: string | null = null;

      try {
        const privyInfo = await verifyPrivyToken(privyToken);
        if (privyInfo) {
          verifiedUserId = privyInfo.privyUserId;
        }
      } catch (err) {
        console.warn(
          "[AgentRoutes] Privy token verification failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Invalid or expired Privy token. Please log in again.",
        });
      }

      const db = getDatabaseDb();
      if (!db) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Database system not available",
        });
      }

      const mapping = await getAgentMappingById(db, agentId);
      if (!mapping) {
        return reply.status(404).send({
          success: false,
          error: "Agent not found",
        });
      }

      // SECURITY: Verify the authenticated user owns this agent
      if (mapping.accountId !== verifiedUserId) {
        console.warn(
          `[AgentRoutes] ❌ SECURITY: User ${verifiedUserId} tried to get spectator token for agent ${agentId} owned by ${mapping.accountId}`,
        );
        return reply.status(403).send({
          success: false,
          error: "You do not have permission to spectate this agent",
        });
      }

      // Generate 7-day spectator JWT
      const spectatorToken = await createJWT({
        userId: verifiedUserId,
        characterId: mapping.characterId,
        agentId: agentId,
        isSpectator: true,
      });

      // Check if the agent's player entity exists in the game world
      // This helps the dashboard know when the agent has fully connected
      const characterId = mapping.characterId;
      const entityFromGet = world.entities.get(characterId);
      const entityFromItems = (
        world.entities as { items?: Map<string, unknown> }
      ).items?.get(characterId);
      const entityFromPlayers = (
        world.entities as { players?: Map<string, unknown> }
      ).players?.get(characterId);
      const entityExists =
        entityFromGet != null ||
        entityFromItems != null ||
        entityFromPlayers != null;

      // Debug: List all player entities currently in the world
      const playersMap = (world.entities as { players?: Map<string, unknown> })
        .players;
      const playerIds = playersMap ? Array.from(playersMap.keys()) : [];

      console.log(
        `[AgentRoutes] 🔍 Entity check for characterId=${characterId}:`,
        `\n  - world.entities.get(): ${entityFromGet ? "FOUND" : "null"}`,
        `\n  - world.entities.items.get(): ${entityFromItems ? "FOUND" : "null"}`,
        `\n  - world.entities.players.get(): ${entityFromPlayers ? "FOUND" : "null"}`,
        `\n  - All player IDs in world: [${playerIds.join(", ")}]`,
        `\n  - entityExists: ${entityExists}`,
      );

      console.log(
        `[AgentRoutes] ✅ Generated spectator JWT for user ${verifiedUserId} watching agent ${mapping.agentName} (entityExists: ${entityExists})`,
      );

      return reply.send({
        success: true,
        spectatorToken,
        characterId: mapping.characterId,
        agentName: mapping.agentName,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // Token expires in 7 days
        entityExists, // Whether the agent's player entity is in the game world
      });
    } catch (error) {
      console.error(
        "[AgentRoutes] ❌ Failed to generate spectator token:",
        error,
      );

      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate spectator token",
      });
    }
  });

  /**
   * GET /api/agents/:agentId/goal
   *
   * Get the current goal for an agent.
   * Used by the dashboard to display agent goal progress.
   *
   * Response:
   * {
   *   success: true,
   *   goal: { type, description, progress, target, ... } | null
   * }
   */
  fastify.get(
    "/api/agents/:agentId/goal",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);

        if (!characterId) {
          // Agent not registered yet - return success with null goal
          return reply.send({
            success: true,
            goal: null,
            message: "Agent not registered in game yet",
          });
        }

        // Get goal and available goals from ServerNetwork storage
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        const goal = ServerNetwork.agentGoals.get(characterId);
        const availableGoals =
          ServerNetwork.agentAvailableGoals.get(characterId) || [];
        const goalsPaused =
          ServerNetwork.agentGoalsPaused.get(characterId) || false;
        const personality =
          ServerNetwork.agentPersonality.get(characterId) || null;
        const desireScores =
          ServerNetwork.agentDesireScores.get(characterId) || [];

        if (!goal) {
          return reply.send({
            success: true,
            goal: null,
            availableGoals,
            goalsPaused,
            personality,
            desireScores,
            message: goalsPaused ? "Goals paused by user" : "No active goal",
          });
        }

        // Calculate progress percentage
        const goalData = goal as {
          progress?: number;
          target?: number;
          startedAt?: number;
          locked?: boolean;
          lockedBy?: string;
        };
        const progressPercent =
          goalData.target && goalData.target > 0
            ? Math.round(((goalData.progress || 0) / goalData.target) * 100)
            : 0;

        return reply.send({
          success: true,
          goal: {
            ...goalData,
            progressPercent,
            elapsedMs: goalData.startedAt ? Date.now() - goalData.startedAt : 0,
          },
          availableGoals,
          goalsPaused,
          personality,
          desireScores,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to fetch agent goal:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch agent goal",
          goal: null,
        });
      }
    },
  );

  /**
   * POST /api/agents/:agentId/goal
   *
   * Set a new goal for an agent from the dashboard.
   * Sends a goalOverride packet to the agent's plugin via WebSocket.
   *
   * Request body:
   * {
   *   goalId: string  // ID of the goal to set (from availableGoals)
   * }
   *
   * Response:
   * {
   *   success: true,
   *   message: "Goal change requested"
   * }
   */
  fastify.post(
    "/api/agents/:agentId/goal",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const body = request.body as { goalId?: string };
        const { agentId } = params;
        const { goalId } = body;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        if (!goalId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required body parameter: goalId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.status(404).send({
            success: false,
            error: "Agent not registered in game",
          });
        }

        // Get the socket for this character
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        const socket = ServerNetwork.characterSockets.get(characterId);

        if (!socket) {
          return reply.status(404).send({
            success: false,
            error: "Agent not connected (no active WebSocket)",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            if (mapping.characterId !== characterId) {
              throw new Error("agent_mapping_identity_changed");
            }
            socket.send("goalOverride", {
              goalId,
              source: "dashboard",
            });
            ServerNetwork.agentGoalsPaused.set(characterId, false);
          },
        );
        if (!mutation) return;

        console.log(
          `[AgentRoutes] 🎯 Sent goalOverride to ${characterId}: ${goalId}`,
        );

        return reply.send({
          success: true,
          message: `Goal change requested: ${goalId}`,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to set agent goal:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to set agent goal",
        });
      }
    },
  );

  /**
   * POST /api/agents/:agentId/goal/unlock
   *
   * Unlock the current goal, allowing autonomous behavior to change it.
   */
  fastify.post(
    "/api/agents/:agentId/goal/unlock",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.status(404).send({
            success: false,
            error: "Agent not registered in game",
          });
        }

        // Get the socket for this character
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        const socket = ServerNetwork.characterSockets.get(characterId);

        if (!socket) {
          return reply.status(404).send({
            success: false,
            error: "Agent not connected (no active WebSocket)",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            if (mapping.characterId !== characterId) {
              throw new Error("agent_mapping_identity_changed");
            }
            socket.send("goalOverride", {
              unlock: true,
              source: "dashboard",
            });
          },
        );
        if (!mutation) return;

        console.log(`[AgentRoutes] 🔓 Sent goal unlock to ${characterId}`);

        return reply.send({
          success: true,
          message: "Goal unlocked",
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to unlock agent goal:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to unlock goal",
        });
      }
    },
  );

  /**
   * POST /api/agents/:agentId/goal/stop
   *
   * Stop/clear the current goal, making the agent idle.
   */
  fastify.post(
    "/api/agents/:agentId/goal/stop",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.status(404).send({
            success: false,
            error: "Agent not registered in game",
          });
        }

        // Get the socket for this character
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        const socket = ServerNetwork.characterSockets.get(characterId);

        if (!socket) {
          return reply.status(404).send({
            success: false,
            error: "Agent not connected (no active WebSocket)",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            if (mapping.characterId !== characterId) {
              throw new Error("agent_mapping_identity_changed");
            }
            socket.send("goalOverride", {
              stop: true,
              source: "dashboard",
            });
            ServerNetwork.agentGoalsPaused.set(characterId, true);
            await new Promise((resolve) =>
              setTimeout(resolve, COMMAND_ACK_DELAY_MS),
            );
          },
        );
        if (!mutation) return;

        console.log(`[AgentRoutes] ⏹️ Sent goal stop to ${characterId}`);

        return reply.send({
          success: true,
          message: "Goal stopped",
          acknowledgedAt: Date.now(),
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to stop agent goal:", error);

        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : "Failed to stop goal",
        });
      }
    },
  );

  /**
   * POST /api/agents/:agentId/goal/resume
   *
   * Resume autonomous goal setting after being paused.
   * Clears the paused flag and allows the agent to pick goals again.
   */
  fastify.post(
    "/api/agents/:agentId/goal/resume",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.status(404).send({
            success: false,
            error: "Agent not registered in game",
          });
        }

        // Get the socket for this character
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        const socket = ServerNetwork.characterSockets.get(characterId);

        if (!socket) {
          return reply.status(404).send({
            success: false,
            error: "Agent not connected (no active WebSocket)",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            if (mapping.characterId !== characterId) {
              throw new Error("agent_mapping_identity_changed");
            }
            socket.send("goalOverride", {
              resume: true,
              source: "dashboard",
            });
            ServerNetwork.agentGoalsPaused.set(characterId, false);
            await new Promise((resolve) =>
              setTimeout(resolve, COMMAND_ACK_DELAY_MS),
            );
          },
        );
        if (!mutation) return;

        console.log(`[AgentRoutes] ▶️ Sent goal resume to ${characterId}`);

        return reply.send({
          success: true,
          message: "Goals resumed",
          acknowledgedAt: Date.now(),
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to resume agent goals:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to resume goals",
        });
      }
    },
  );

  /**
   * GET /api/agents/:agentId/quick-actions
   *
   * Get quick action data for the dashboard menu.
   * Returns nearby locations, available goals, quick commands, and inventory.
   *
   * Response:
   * {
   *   success: true,
   *   nearbyLocations: [...],
   *   availableGoals: [...],
   *   quickCommands: [...],
   *   inventory: [...],
   *   playerPosition: [x, y, z]
   * }
   */
  fastify.get(
    "/api/agents/:agentId/quick-actions",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);

        if (!characterId) {
          return reply.send({
            success: true,
            nearbyLocations: [],
            availableGoals: [],
            quickCommands: [],
            inventory: [],
            playerPosition: null,
            message: "Agent not registered in game yet",
          });
        }

        // Get player entity from world
        const playersMap = (
          world.entities as { players?: Map<string, unknown> }
        ).players;
        const playerEntity = playersMap?.get(characterId) as
          Record<string, unknown> | undefined;

        if (!playerEntity) {
          return reply.send({
            success: true,
            nearbyLocations: [],
            availableGoals: [],
            quickCommands: [],
            inventory: [],
            playerPosition: null,
            message: "Agent not connected to game",
          });
        }

        // Get player position
        const playerPos = playerEntity.position as
          | [number, number, number]
          | { x: number; y: number; z: number }
          | undefined;

        let playerPosition: [number, number, number] | null = null;
        if (Array.isArray(playerPos)) {
          playerPosition = playerPos;
        } else if (playerPos && typeof playerPos === "object") {
          playerPosition = [
            playerPos.x || 0,
            playerPos.y || 0,
            playerPos.z || 0,
          ];
        }

        // Helper to calculate distance
        const calcDistance = (
          pos1: [number, number, number],
          pos2: [number, number, number],
        ): number => {
          const dx = pos2[0] - pos1[0];
          const dy = pos2[1] - pos1[1];
          const dz = pos2[2] - pos1[2];
          return Math.sqrt(dx * dx + dy * dy + dz * dz);
        };

        // Helper to get entity position
        const getEntityPos = (
          entity: Record<string, unknown>,
        ): [number, number, number] | null => {
          const pos = entity.position as
            | [number, number, number]
            | { x: number; y: number; z: number }
            | undefined;
          if (Array.isArray(pos)) return pos;
          if (pos && typeof pos === "object") {
            return [pos.x || 0, pos.y || 0, pos.z || 0];
          }
          return null;
        };

        // Categorize entity by name
        const categorizeEntity = (
          name: string,
        ):
          | "bank"
          | "furnace"
          | "tree"
          | "fishing_spot"
          | "anvil"
          | "store"
          | "mob"
          | null => {
          const lowerName = name.toLowerCase();
          if (lowerName.includes("bank")) return "bank";
          if (lowerName.includes("furnace") || lowerName.includes("smelter"))
            return "furnace";
          if (lowerName.includes("anvil")) return "anvil";
          if (
            lowerName.includes("store") ||
            lowerName.includes("shop") ||
            lowerName.includes("general")
          )
            return "store";
          if (
            lowerName.includes("tree") ||
            lowerName.includes("oak") ||
            lowerName.includes("willow")
          )
            return "tree";
          if (
            lowerName.includes("fish") ||
            lowerName.includes("spot") ||
            lowerName.includes("water")
          )
            return "fishing_spot";
          if (lowerName.includes("goblin") || lowerName.includes("mob"))
            return "mob";
          return null;
        };

        // Collect nearby entities (within 100 units)
        const nearbyLocations: Array<{
          id: string;
          name: string;
          type: string;
          distance: number;
        }> = [];

        let hasNearbyMobs = false;
        let hasNearbyTrees = false;
        let hasGroundItems = false;
        let hasNearbyBank = false;
        let hasNearbyFish = false;
        let hasNearbyOre = false;

        const entitiesMap =
          (world.entities as { items?: Map<string, unknown> }).items ||
          new Map();
        for (const [id, entity] of entitiesMap.entries()) {
          if (id === characterId) continue; // Skip self

          const entityAny = entity as Record<string, unknown>;
          const entityName = (entityAny.name || "") as string;
          const entityPos = getEntityPos(entityAny);

          if (!entityPos || !playerPosition) continue;

          const distance = calcDistance(playerPosition, entityPos);
          if (distance > 100) continue; // Only within 100 units

          const type = categorizeEntity(entityName);
          if (type) {
            nearbyLocations.push({
              id: id as string,
              name: entityName,
              type,
              distance: Math.round(distance),
            });

            // Track what's available
            if (type === "mob") hasNearbyMobs = true;
            if (type === "tree") hasNearbyTrees = true;
            if (type === "bank") hasNearbyBank = true;
            if (type === "fishing_spot") hasNearbyFish = true;
          }

          // Check for ore deposits
          const resourceType =
            (entityAny.resourceType as string)?.toLowerCase() || "";
          if (
            resourceType === "ore" ||
            entityName.toLowerCase().includes("ore") ||
            entityName.toLowerCase().includes("rock")
          ) {
            hasNearbyOre = true;
          }

          // Check for fishing spots
          if (
            resourceType === "fish" ||
            entityName.toLowerCase().includes("fishing")
          ) {
            hasNearbyFish = true;
          }

          // Check for ground items
          if (
            entityAny.itemType ||
            entityAny.isItem ||
            (entityAny.type as string)?.includes("item")
          ) {
            hasGroundItems = true;
          }
        }

        // Sort by distance
        nearbyLocations.sort((a, b) => a.distance - b.distance);

        // Get available goals from ServerNetwork storage
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        const availableGoalsRaw = (ServerNetwork.agentAvailableGoals.get(
          characterId,
        ) || []) as Array<{
          id: string;
          type: string;
          description: string;
          priority: number;
        }>;
        const availableGoals = availableGoalsRaw.map((g) => ({
          id: g.id,
          type: g.type,
          description: g.description,
          priority: g.priority,
        }));

        // Build quick commands based on what's available
        const quickCommands = [
          {
            id: "chop_tree",
            label: "Woodcutting",
            command: "chop nearest tree",
            icon: "TreePine",
            available: hasNearbyTrees,
            reason: hasNearbyTrees ? undefined : "No trees nearby",
          },
          {
            id: "mine_ore",
            label: "Mining",
            command: "mine nearest ore",
            icon: "Pickaxe",
            available: hasNearbyOre,
            reason: hasNearbyOre ? undefined : "No ore nearby",
          },
          {
            id: "catch_fish",
            label: "Fishing",
            command: "fish at nearest spot",
            icon: "Fish",
            available: hasNearbyFish,
            reason: hasNearbyFish ? undefined : "No fishing spots",
          },
          {
            id: "attack_nearest",
            label: "Combat",
            command: "attack nearest goblin",
            icon: "Swords",
            available: hasNearbyMobs,
            reason: hasNearbyMobs ? undefined : "No enemies nearby",
          },
          {
            id: "pickup_items",
            label: "Pick Up",
            command: "pick up nearby items",
            icon: "Package",
            available: hasGroundItems,
            reason: hasGroundItems ? undefined : "No items nearby",
          },
          {
            id: "go_to_bank",
            label: "Bank",
            command: "go to bank",
            icon: "Building2",
            available: hasNearbyBank,
            reason: hasNearbyBank ? undefined : "Bank not nearby",
          },
          {
            id: "stop",
            label: "Stop",
            command: "stop",
            icon: "Square",
            available: true,
            reason: undefined,
          },
          {
            id: "idle",
            label: "Idle",
            command: "idle",
            icon: "Pause",
            available: true,
            reason: undefined,
          },
        ];

        // Get player inventory from inventory system
        const invSystem = world.getSystem("inventory") as
          | {
              getInventoryData?: (id: string) => {
                items: Array<{
                  id?: string;
                  itemId?: string;
                  name?: string;
                  slot?: number;
                  quantity?: number;
                }>;
                coins: number;
                maxSlots: number;
              };
            }
          | undefined;

        // Get data manager to look up item names
        const dataManager = (
          world as {
            dataManager?: {
              getItem?: (id: string) =>
                | {
                    name?: string;
                    equippable?: boolean;
                    consumable?: boolean;
                    slot?: string;
                  }
                | undefined;
            };
          }
        ).dataManager;

        const invData = invSystem?.getInventoryData?.(characterId);
        const playerItems = invData?.items || [];

        const inventory = playerItems.map((item, index) => {
          // Look up item info from manifest
          const itemInfo = dataManager?.getItem?.(item.itemId || "");
          const name =
            item.name || itemInfo?.name || item.itemId || "Unknown Item";
          // Check if equippable based on slot type
          const canEquip =
            itemInfo?.equippable ??
            (itemInfo?.slot != null && itemInfo.slot !== "none");
          const canUse = itemInfo?.consumable ?? false;

          return {
            id: item.id || item.itemId || `item-${index}`,
            name,
            slot: item.slot ?? index,
            quantity: item.quantity ?? 1,
            canEquip,
            canUse,
            canDrop: true,
          };
        });

        return reply.send({
          success: true,
          nearbyLocations: nearbyLocations.slice(0, 10), // Limit to 10
          availableGoals,
          quickCommands,
          inventory: inventory.slice(0, 20), // Limit to 20
          playerPosition,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to fetch quick actions:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch quick actions",
        });
      }
    },
  );

  /**
   * GET /api/debug/resources
   *
   * Get all resources in the world (trees, fishing spots, etc.)
   * Used for debugging and finding resource locations.
   */
  fastify.get("/api/debug/resources", async (_request, reply) => {
    if (!isLocalDiagnosticDuelRuntime(process.env)) {
      return reply.status(404).send({ error: "Not found" });
    }

    try {
      // Get all entities from world
      const entities: Array<{
        id: string;
        name: string;
        type: string;
        resourceType?: string;
        position: [number, number, number];
      }> = [];

      const entitiesMap =
        (world.entities as { items?: Map<string, unknown> }).items || new Map();
      for (const [id, entity] of entitiesMap.entries()) {
        const entityAny = entity as Record<string, unknown>;
        const position = entityAny.position as
          | [number, number, number]
          | { x: number; y: number; z: number }
          | undefined;

        let posArray: [number, number, number] = [0, 0, 0];
        if (Array.isArray(position)) {
          posArray = position;
        } else if (position && typeof position === "object") {
          posArray = [position.x || 0, position.y || 0, position.z || 0];
        }

        // Check if it's a resource
        const resourceType = entityAny.resourceType as string | undefined;
        const type = (entityAny.type || entityAny.entityType || "") as string;
        const name = (entityAny.name || "") as string;

        if (
          resourceType ||
          type === "resource" ||
          /tree|fishing|ore|herb/i.test(name)
        ) {
          entities.push({
            id: id as string,
            name,
            type,
            resourceType,
            position: posArray,
          });
        }
      }

      // Get resources from TerrainSystem tiles
      const terrainSystem = world.getSystem("terrain") as unknown as {
        getTiles?: () => Map<
          string,
          {
            x: number;
            z: number;
            resources: Array<{
              id: string;
              type: string;
              position: { x: number; y: number; z: number };
            }>;
          }
        >;
        CONFIG?: { TILE_SIZE: number };
      } | null;

      const tileSize = terrainSystem?.CONFIG?.TILE_SIZE || 100;
      const terrainResources: Array<{
        id: string;
        type: string;
        position: [number, number, number];
        tileKey: string;
      }> = [];

      const tiles = terrainSystem?.getTiles?.();
      if (tiles) {
        for (const [key, tile] of tiles.entries()) {
          for (const resource of tile.resources || []) {
            // Resource position is relative to tile - convert to world position
            const worldX = tile.x * tileSize + resource.position.x;
            const worldY = resource.position.y;
            const worldZ = tile.z * tileSize + resource.position.z;

            terrainResources.push({
              id: resource.id,
              type: resource.type,
              position: [worldX, worldY, worldZ],
              tileKey: key,
            });
          }
        }
      }

      // Filter for trees specifically
      const trees = terrainResources.filter((r) => r.type === "tree");

      return reply.send({
        success: true,
        entities,
        terrainResources,
        trees,
        treeCount: trees.length,
        tileCount: tiles?.size || 0,
        totalEntities: entitiesMap.size,
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to fetch resources:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch resources",
      });
    }
  });

  /**
   * GET /api/agents/:agentId/activity
   *
   * Get recent activity and session stats for an agent.
   * Returns significant events like kills, XP gains, item pickups, and goal changes.
   *
   * Response:
   * {
   *   success: true,
   *   recentActions: [...],
   *   sessionStats: { kills, deaths, totalXpGained, goldEarned, resourcesGathered }
   * }
   */
  fastify.get(
    "/api/agents/:agentId/activity",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.send({
            success: true,
            recentActions: [],
            sessionStats: {
              kills: 0,
              deaths: 0,
              totalXpGained: 0,
              goldEarned: 0,
              resourcesGathered: {},
            },
            message: "Agent not registered in game yet",
          });
        }

        // Get activity from ServerNetwork storage (if we add activity tracking there)
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");

        // Check if activity tracking exists
        const activityData = (
          ServerNetwork as {
            agentActivity?: Map<
              string,
              {
                recentActions: Array<{
                  type: string;
                  description: string;
                  xpGained?: number;
                  timestamp: number;
                }>;
                sessionStats: {
                  kills: number;
                  deaths: number;
                  totalXpGained: number;
                  goldEarned: number;
                  resourcesGathered: Record<string, number>;
                };
              }
            >;
          }
        ).agentActivity?.get(characterId);

        if (activityData) {
          return reply.send({
            success: true,
            recentActions: activityData.recentActions.slice(0, 100),
            sessionStats: activityData.sessionStats,
          });
        }

        // Return empty activity if no tracking data yet
        return reply.send({
          success: true,
          recentActions: [],
          sessionStats: {
            kills: 0,
            deaths: 0,
            totalXpGained: 0,
            goldEarned: 0,
            resourcesGathered: {},
          },
          message: "Activity tracking not yet available for this agent",
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to fetch agent activity:",
          error,
        );

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch agent activity",
        });
      }
    },
  );

  /**
   * GET /api/agents/:agentId/quests
   *
   * Get all quests with per-agent status for the dashboard quest panel.
   * Returns every quest definition with its status (not_started, in_progress,
   * ready_to_complete, completed) so the dashboard can show them all.
   *
   * Response:
   * {
   *   success: true,
   *   quests: [{ id, name, status, difficulty, questPoints, startNpc, stageType?, stageTarget?, stageCount?, stageProgress? }],
   *   questPoints: number
   * }
   */
  fastify.get(
    "/api/agents/:agentId/quests",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);

        if (!characterId) {
          return reply.send({
            success: true,
            quests: [],
            questPoints: 0,
            message: "Agent not registered in game yet",
          });
        }

        // Get QuestSystem from world
        const questSystem = world.getSystem("quest") as
          | {
              getAllQuestDefinitions: () => Array<{
                id: string;
                name: string;
                difficulty: string;
                questPoints: number;
                startNpc: string;
                stages: Array<{
                  id: string;
                  type: string;
                  target: string;
                  count: number;
                }>;
              }>;
              getQuestStatus: (playerId: string, questId: string) => string;
              getActiveQuests: (playerId: string) => Array<{
                questId: string;
                currentStage: string;
                stageProgress: Record<string, number>;
              }>;
              getQuestPoints: (playerId: string) => number;
            }
          | undefined;

        if (!questSystem) {
          return reply.send({
            success: true,
            quests: [],
            questPoints: 0,
            message: "Quest system not available",
          });
        }

        const allDefinitions = questSystem.getAllQuestDefinitions();
        const activeQuests = questSystem.getActiveQuests(characterId);

        const quests = allDefinitions.map((def) => {
          const status = questSystem.getQuestStatus(characterId, def.id);
          const active = activeQuests.find((aq) => aq.questId === def.id);
          const currentStage = active
            ? def.stages.find((s) => s.id === active.currentStage)
            : undefined;

          return {
            id: def.id,
            name: def.name,
            status,
            difficulty: def.difficulty,
            questPoints: def.questPoints,
            startNpc: def.startNpc,
            ...(active && currentStage
              ? {
                  stageType: currentStage.type,
                  stageTarget: currentStage.target,
                  stageCount: currentStage.count,
                  stageProgress: active.stageProgress,
                }
              : {}),
          };
        });

        const questPoints = questSystem.getQuestPoints(characterId);

        return reply.send({
          success: true,
          quests,
          questPoints,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to fetch agent quests:", error);

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch agent quests",
        });
      }
    },
  );

  /**
   * GET /api/agents/:agentId/thoughts
   *
   * Get recent thought process for an agent.
   * Used by the dashboard to display agent's decision-making process.
   *
   * Query params:
   * - limit: number (default: 100, max: 200) - Number of thoughts to return
   * - since: number (timestamp) - Only return thoughts after this timestamp
   *
   * Response:
   * {
   *   success: true,
   *   thoughts: [...],
   *   count: number
   * }
   */
  fastify.get(
    "/api/agents/:agentId/thoughts",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const query = request.query as { limit?: string; since?: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        // Parse query params
        const limit = Math.min(parseInt(query.limit || "100", 10), 200);
        const since = query.since ? parseInt(query.since, 10) : 0;

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.send({
            success: true,
            thoughts: [],
            count: 0,
            message: "Agent not registered in game yet",
          });
        }

        // Get thoughts from ServerNetwork in-memory cache first
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");

        let thoughts = ServerNetwork.agentThoughts.get(characterId) || [];

        // If in-memory is empty (e.g. after restart), hydrate from DB
        if (thoughts.length === 0 && db) {
          await hydrateThoughtsFromDb(characterId);
          thoughts = ServerNetwork.agentThoughts.get(characterId) || [];
        }

        // Filter by since timestamp and limit
        let filteredThoughts = thoughts;
        if (since > 0) {
          filteredThoughts = thoughts.filter((t) => t.timestamp > since);
        }
        filteredThoughts = filteredThoughts.slice(0, limit);

        return reply.send({
          success: true,
          thoughts: filteredThoughts,
          count: filteredThoughts.length,
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to fetch agent thoughts:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch agent thoughts",
        });
      }
    },
  );

  /**
   * DELETE /api/agents/:agentId/thoughts
   *
   * Clear all thought history for an agent.
   * Used to reset the thought log.
   */
  fastify.delete(
    "/api/agents/:agentId/thoughts",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentId) {
          return reply.status(400).send({
            success: false,
            error: "Missing required parameter: agentId",
          });
        }

        const db = getDatabaseDb();
        if (!db) {
          return reply.status(500).send({
            success: false,
            error: "Database system not available",
          });
        }

        const characterId = await resolveAgentCharacterId(db, agentId, true);
        if (!characterId) {
          return reply.send({
            success: true,
            message: "Agent not registered in game",
          });
        }

        // Clear thoughts from ServerNetwork storage
        const { ServerNetwork } =
          await import("../../systems/ServerNetwork/index.js");
        ServerNetwork.agentThoughts.delete(characterId);

        console.log(
          `[AgentRoutes] 🗑️ Cleared thoughts for character ${characterId}`,
        );

        return reply.send({
          success: true,
          message: "Thought history cleared",
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to clear agent thoughts:",
          error,
        );

        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to clear agent thoughts",
        });
      }
    },
  );

  // ===========================================================================
  // EMBEDDED AGENT ROUTES
  // These routes manage agents running directly on the server
  // ===========================================================================

  /**
   * POST /api/embedded-agents
   *
   * Create and start an embedded agent.
   * The agent will run directly on the server without an external ElizaOS process.
   *
   * Request body:
   * {
   *   characterId: "character-uuid",
   *   autoStart?: boolean,  // defaults to true
   *   scriptedRole?: "combat" | "woodcutting" | "fishing" | "mining" | "balanced"
   * }
   */
  fastify.post("/api/embedded-agents", async (request, reply) => {
    try {
      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      const { getAgentManager } = await import("../../eliza/index.js");
      const agentManager = getAgentManager();

      if (!agentManager) {
        return reply.status(503).send({
          success: false,
          error: "Agent system not initialized",
        });
      }

      const body = request.body as {
        characterId?: string;
        autoStart?: boolean;
        scriptedRole?:
          "combat" | "woodcutting" | "fishing" | "mining" | "balanced";
      };

      if (!body.characterId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required field: characterId",
        });
      }

      // Capture characterId after validation to narrow type from string | undefined to string
      const inputCharacterId = body.characterId;

      // Get character from database to retrieve accountId and name
      const databaseSystem = world.getSystem("database") as
        | {
            db: {
              select: (fields?: unknown) => {
                from: (table: unknown) => {
                  where: (condition: unknown) => Promise<unknown[]>;
                };
              };
              insert: (table: unknown) => {
                values: (values: Record<string, unknown>) => {
                  onConflictDoUpdate: (config: {
                    set: Record<string, unknown>;
                    target: unknown;
                  }) => Promise<unknown>;
                } & Promise<unknown>;
              };
              delete: (table: unknown) => {
                where: (condition: unknown) => Promise<unknown>;
              };
              query: {
                characters: {
                  findFirst: (opts: {
                    where: (
                      chars: { id: unknown },
                      ops: { eq: (a: unknown, b: string) => unknown },
                    ) => unknown;
                  }) => Promise<{
                    id: string;
                    accountId: string;
                    name: string;
                  } | null>;
                };
              };
            };
          }
        | undefined;

      if (!databaseSystem?.db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const character = await databaseSystem.db.query.characters.findFirst({
        where: (chars, ops) => ops.eq(chars.id, inputCharacterId),
      });

      if (!character || character.accountId !== verifiedUserId) {
        return reply.status(403).send({
          success: false,
          error: "Character not found or access denied",
        });
      }

      const pool = getDatabasePool();
      if (!pool) {
        return reply.status(500).send({
          success: false,
          error: "Transactional database authority not available",
        });
      }
      const savedMapping = await savePersistedAgentMapping({
        pool,
        agentId: character.id,
        accountId: character.accountId,
        characterId: character.id,
        agentName: character.name,
      });
      if (savedMapping.status !== "saved") {
        return reply
          .status(savedMapping.status === "character_forbidden" ? 403 : 409)
          .send({
            success: false,
            error:
              savedMapping.status === "character_forbidden"
                ? "Character not found or access denied"
                : "Agent or character is already mapped",
          });
      }
      invalidateAgentMappingCache(character.id, character.accountId);
      primeAgentMappingCache(savedMapping.mapping);

      // Create the embedded agent
      const characterId = await agentManager.createAgent({
        characterId: character.id,
        accountId: character.accountId,
        name: character.name,
        scriptedRole: body.scriptedRole,
        autoStart: body.autoStart !== false,
      });

      const agentInfo = agentManager.getAgentInfo(characterId);

      console.log(
        `[AgentRoutes] ✅ Embedded agent created: ${character.name} (${characterId})`,
      );

      return reply.send({
        success: true,
        agent: agentInfo,
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to create embedded agent:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to create embedded agent",
      });
    }
  });

  /**
   * GET /api/embedded-agents
   *
   * List all embedded agents.
   * Optionally filter by accountId.
   */
  fastify.get("/api/embedded-agents", async (request, reply) => {
    try {
      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      const { getAgentManager, getRunningAgents } =
        await import("../../eliza/index.js");
      const agentManager = getAgentManager();

      if (!agentManager) {
        return reply.status(503).send({
          success: false,
          error: "Agent system not initialized",
        });
      }

      const query = request.query as { accountId?: string };
      if (query.accountId && query.accountId !== verifiedUserId) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
      }
      const managedAgents = agentManager.getAgentsByAccount(verifiedUserId);
      const runningModelAgents = Array.from(
        (
          getRunningAgents() as Map<
            string,
            {
              characterId: string;
              accountId: string;
              config: {
                displayName: string;
              };
            }
          >
        ).values(),
      )
        .filter((agent) => agent.accountId === verifiedUserId)
        .map((agent) => ({
          agentId: agent.characterId,
          characterId: agent.characterId,
          accountId: agent.accountId,
          name: agent.config.displayName,
          state: "running" as const,
          entityId: agent.characterId,
          position: null,
          health: null,
          maxHealth: null,
          startedAt: Date.now(),
          lastActivity: Date.now(),
        }));

      const mergedByCharacterId = new Map<string, unknown>();
      for (const agent of managedAgents) {
        mergedByCharacterId.set(
          (agent as { characterId: string }).characterId,
          agent,
        );
      }
      for (const agent of runningModelAgents) {
        mergedByCharacterId.set(
          (agent as { characterId: string }).characterId,
          agent,
        );
      }

      const agents = Array.from(mergedByCharacterId.values());

      return reply.send({
        success: true,
        agents,
        count: agents.length,
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to list embedded agents:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list embedded agents",
      });
    }
  });

  /**
   * GET /api/embedded-agents/:characterId
   *
   * Get information about a specific embedded agent.
   */
  fastify.get(
    "/api/embedded-agents/:characterId",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager, getRunningAgents } =
          await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const { characterId } = request.params as { characterId: string };
        const agentInfo = agentManager.getAgentInfo(characterId);

        if (!agentInfo) {
          const runningModelAgent = Array.from(
            (
              getRunningAgents() as Map<
                string,
                {
                  characterId: string;
                  accountId: string;
                  config: { displayName: string };
                }
              >
            ).values(),
          ).find((agent) => agent.characterId === characterId);

          if (!runningModelAgent) {
            return reply.status(404).send({
              success: false,
              error: "Agent not found",
            });
          }

          return reply.send({
            success: true,
            agent: {
              agentId: runningModelAgent.characterId,
              characterId: runningModelAgent.characterId,
              accountId: runningModelAgent.accountId,
              name: runningModelAgent.config.displayName,
              state: "running",
              entityId: runningModelAgent.characterId,
            },
            source: "model-agent-fallback",
          });
        }

        return reply.send({
          success: true,
          agent: agentInfo,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to get embedded agent:", error);
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get embedded agent",
        });
      }
    },
  );

  /**
   * POST /api/embedded-agents/:characterId/start
   *
   * Start an embedded agent.
   */
  fastify.post(
    "/api/embedded-agents/:characterId/start",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.startAgent(mapping.characterId);
            return agentManager.getAgentInfo(mapping.characterId);
          },
        );
        if (!mutation) return;

        return reply.send({
          success: true,
          agent: mutation.value,
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to start embedded agent:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to start embedded agent",
        });
      }
    },
  );

  /**
   * POST /api/embedded-agents/:characterId/stop
   *
   * Stop an embedded agent.
   */
  fastify.post(
    "/api/embedded-agents/:characterId/stop",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.stopAgent(mapping.characterId);
          },
        );
        if (!mutation) return;
        const agentInfo = agentManager.getAgentInfo(
          mutation.mapping.characterId,
        );

        return reply.send({
          success: true,
          agent: agentInfo,
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to stop embedded agent:", error);
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to stop embedded agent",
        });
      }
    },
  );

  /**
   * POST /api/embedded-agents/:characterId/pause
   *
   * Pause an embedded agent (keep entity but stop behavior).
   */
  fastify.post(
    "/api/embedded-agents/:characterId/pause",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.pauseAgent(mapping.characterId);
          },
        );
        if (!mutation) return;
        const agentInfo = agentManager.getAgentInfo(
          mutation.mapping.characterId,
        );

        return reply.send({
          success: true,
          agent: agentInfo,
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to pause embedded agent:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to pause embedded agent",
        });
      }
    },
  );

  /**
   * POST /api/embedded-agents/:characterId/resume
   *
   * Resume a paused embedded agent.
   */
  fastify.post(
    "/api/embedded-agents/:characterId/resume",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.resumeAgent(mapping.characterId);
            return agentManager.getAgentInfo(mapping.characterId);
          },
        );
        if (!mutation) return;

        return reply.send({
          success: true,
          agent: mutation.value,
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to resume embedded agent:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to resume embedded agent",
        });
      }
    },
  );

  /**
   * POST /api/embedded-agents/:characterId/command
   *
   * Send a command to an embedded agent.
   *
   * Request body:
   * {
   *   command: "move" | "attack" | "gather" | "pickup" | "drop" | "equip" | "use" | "chat" | "stop",
   *   data: { ... }  // command-specific data
   * }
   */
  type EmbeddedAgentCommandData = {
    target?: [number, number, number];
    runMode?: boolean;
    targetId?: string;
    resourceId?: string;
    itemId?: string;
    quantity?: number;
    equipSlot?: string;
    slot?: number;
    message?: string;
    skill?: "woodcutting" | "fishing" | "mining" | "firemaking" | "cooking";
  };

  fastify.post(
    "/api/embedded-agents/:characterId/command",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const body = request.body as {
          command?: string;
          data?: EmbeddedAgentCommandData;
        };
        const command = body.command || "";
        const data = body.data || {};

        if (!command) {
          return reply.status(400).send({
            success: false,
            error: "Missing required field: command",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.sendCommand(mapping.characterId, command, data);
          },
        );
        if (!mutation) return;

        return reply.send({
          success: true,
          message: `Command ${command} sent to agent`,
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to send command to embedded agent:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to send command to embedded agent",
        });
      }
    },
  );

  /**
   * DELETE /api/embedded-agents/:characterId
   *
   * Remove an embedded agent completely.
   */
  fastify.delete(
    "/api/embedded-agents/:characterId",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.removeAgent(mapping.characterId);
          },
          true,
        );
        if (!mutation) return;
        invalidateAgentMappingCache(
          mutation.mapping.agentId,
          mutation.mapping.accountId,
        );
        const { getStreamingDuelScheduler } =
          await import("../../systems/StreamingDuelScheduler/index.js");
        getStreamingDuelScheduler()?.applyStreamingDuelParticipation(
          mutation.mapping.characterId,
          false,
        );

        return reply.send({
          success: true,
          message: "Agent removed",
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to remove embedded agent:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to remove embedded agent",
        });
      }
    },
  );

  /**
   * GET /api/embedded-agents/:characterId/state
   *
   * Get the full game state for an embedded agent.
   */
  fastify.get(
    "/api/embedded-agents/:characterId/state",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager, getRunningAgents } =
          await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const { characterId } = request.params as { characterId: string };
        const service = agentManager.getAgentService(characterId);

        if (service) {
          const gameState = service.getGameState();
          return reply.send({
            success: true,
            gameState,
          });
        }

        // Fallback for model agents managed by ModelAgentSpawner.
        const runningModelAgents = getRunningAgents() as Map<
          string,
          {
            characterId: string;
          }
        >;
        const runningModelAgent = Array.from(runningModelAgents.values()).find(
          (agent) => agent.characterId === characterId,
        );

        if (!runningModelAgent) {
          return reply.status(404).send({
            success: false,
            error: "Agent not found",
          });
        }

        const entity =
          world.entities.get(characterId) ||
          world.entities.items.get(characterId) ||
          world.entities.players.get(characterId);

        if (!entity) {
          return reply.status(404).send({
            success: false,
            error: "Agent entity not found in world",
          });
        }

        const data = (entity as { data?: Record<string, unknown> }).data || {};
        const rawPosition =
          (data.position as
            | [number, number, number]
            | { x?: number; y?: number; z?: number }
            | undefined) ||
          ((entity as { position?: { x?: number; y?: number; z?: number } })
            .position as { x?: number; y?: number; z?: number } | undefined);

        const position = (() => {
          if (Array.isArray(rawPosition) && rawPosition.length >= 3) {
            return [
              Number(rawPosition[0]) || 0,
              Number(rawPosition[1]) || 0,
              Number(rawPosition[2]) || 0,
            ] as [number, number, number];
          }
          if (
            rawPosition &&
            !Array.isArray(rawPosition) &&
            typeof rawPosition === "object"
          ) {
            const objectPosition = rawPosition as {
              x?: number;
              y?: number;
              z?: number;
            };
            return [
              Number(objectPosition.x) || 0,
              Number(objectPosition.y) || 0,
              Number(objectPosition.z) || 0,
            ] as [number, number, number];
          }
          return [0, 0, 0] as [number, number, number];
        })();

        const gameState = {
          playerId: characterId,
          position,
          health: Number(data.health ?? 10),
          maxHealth: Number(data.maxHealth ?? 10),
          alive: data.alive !== false,
          skills:
            (data.skills as Record<string, { level: number; xp: number }>) ||
            {},
          inventory:
            (data.inventory as Array<{
              slot: number;
              itemId: string;
              quantity: number;
            }>) || [],
          equipment:
            (data.equipment as Record<string, { itemId: string }>) || {},
          nearbyEntities: [],
          inCombat: Boolean(data.inCombat || data.combatTarget),
          currentTarget:
            (data.combatTarget as string | null | undefined) || null,
        };

        return reply.send({
          success: true,
          gameState,
          source: "model-agent-fallback",
        });
      } catch (error) {
        console.error(
          "[AgentRoutes] ❌ Failed to get embedded agent state:",
          error,
        );
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get embedded agent state",
        });
      }
    },
  );

  console.log("[AgentRoutes] ✅ Agent credential routes registered");
  console.log("[AgentRoutes] ✅ Embedded agent routes registered");

  // ===========================================================================
  // ELIZAOS-COMPATIBLE API ROUTES
  // These routes provide ElizaOS API compatibility for the dashboard
  // Maps to the embedded agent system under the hood
  // ===========================================================================

  /**
   * GET /api/agents
   *
   * List all agents (ElizaOS-compatible format).
   * Used by DashboardScreen to list agents.
   *
   * Query params:
   * - accountId?: string - Filter by account ID
   *
   * Response (ElizaOS format):
   * {
   *   success: true,
   *   data: {
   *     agents: [
   *       { id, name, status, ... }
   *     ]
   *   }
   * }
   */
  fastify.get("/api/agents", async (request, reply) => {
    try {
      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      const { getAgentManager, getRunningAgents } =
        await import("../../eliza/index.js");
      const agentManager = getAgentManager();
      const runningModelAgents = getRunningAgents() as Map<
        string,
        {
          config: { displayName: string; provider: string; model: string };
          characterId: string;
          accountId: string;
          service?: {
            getGameState?: () => {
              health?: number;
              maxHealth?: number;
              position?: [number, number, number] | null;
            } | null;
          };
        }
      >;

      const query = request.query as { accountId?: string };
      if (query.accountId && query.accountId !== verifiedUserId) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
      }
      const embeddedAgents = agentManager
        ? agentManager.getAgentsByAccount(verifiedUserId)
        : [];

      // Convert to ElizaOS format
      const elizaAgents: Array<{
        id: string;
        name: string;
        status: string;
        character: {
          name: string;
          settings: Record<string, unknown>;
        };
        createdAt: string;
        updatedAt: string;
      }> = embeddedAgents.map((agent) => ({
        id: agent.agentId,
        name: agent.name,
        status: agent.state === "running" ? "active" : agent.state,
        character: {
          name: agent.name,
          settings: {
            accountId: agent.accountId,
          },
        },
        createdAt: new Date(agent.startedAt).toISOString(),
        updatedAt: new Date(agent.lastActivity).toISOString(),
      }));

      for (const [, runningAgent] of runningModelAgents) {
        if (runningAgent.accountId !== verifiedUserId) {
          continue;
        }

        const gameState = runningAgent.service?.getGameState?.() ?? null;
        const nowIso = new Date().toISOString();

        elizaAgents.push({
          id: runningAgent.characterId,
          name: runningAgent.config.displayName,
          status: "active",
          character: {
            name: runningAgent.config.displayName,
            settings: {
              accountId: runningAgent.accountId,
              characterId: runningAgent.characterId,
              provider: runningAgent.config.provider,
              model: runningAgent.config.model,
              health: gameState?.health ?? null,
              maxHealth: gameState?.maxHealth ?? null,
              position: gameState?.position ?? null,
            },
          },
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }

      const dedupedAgents = Array.from(
        new Map(elizaAgents.map((agent) => [agent.id, agent])).values(),
      );

      return reply.send({
        success: true,
        data: {
          agents: dedupedAgents,
        },
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to list agents:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Failed to list agents",
      });
    }
  });

  /**
   * POST /api/agents
   *
   * Create a new agent (ElizaOS-compatible).
   * Used by CharacterSelectScreen and CharacterEditorScreen.
   *
   * Request body:
   * {
   *   characterJson: {
   *     name: string,
   *     settings: { accountId: string, characterId: string, ... }
   *   }
   * }
   *
   * Response:
   * {
   *   success: true,
   *   data: {
   *     agent: { id, name, status, ... }
   *   }
   * }
   */
  fastify.post("/api/agents", async (request, reply) => {
    try {
      const { getAgentManager } = await import("../../eliza/index.js");
      const agentManager = getAgentManager();

      if (!agentManager) {
        return reply.status(503).send({
          success: false,
          error: "Agent system not initialized",
        });
      }

      const body = request.body as {
        characterJson?: {
          name?: string;
          settings?: {
            accountId?: string;
            characterId?: string;
          };
        };
      };

      const characterJson = body.characterJson;
      if (!characterJson) {
        return reply.status(400).send({
          success: false,
          error: "Missing required field: characterJson",
        });
      }

      const name = characterJson.name || "Agent";
      const accountId = characterJson.settings?.accountId;
      const characterId = characterJson.settings?.characterId;

      if (!accountId || !characterId) {
        return reply.status(400).send({
          success: false,
          error:
            "Missing required fields: characterJson.settings.accountId, characterJson.settings.characterId",
        });
      }

      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Unauthorized",
        });
      }
      if (verifiedUserId !== accountId) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
        });
      }
      const databaseSystem = getDatabaseSystem();
      if (!databaseSystem?.getCharactersAsync) {
        return reply.status(500).send({
          success: false,
          error: "Character ownership authority not available",
        });
      }
      const ownedCharacters =
        await databaseSystem.getCharactersAsync(accountId);
      if (!ownedCharacters.some((character) => character.id === characterId)) {
        return reply.status(403).send({
          success: false,
          error: "Character not found or access denied",
        });
      }
      const pool = getDatabasePool();
      if (!pool) {
        return reply.status(500).send({
          success: false,
          error: "Transactional database authority not available",
        });
      }
      const savedMapping = await savePersistedAgentMapping({
        pool,
        agentId: characterId,
        accountId,
        characterId,
        agentName: name,
      });
      if (savedMapping.status !== "saved") {
        return reply
          .status(savedMapping.status === "character_forbidden" ? 403 : 409)
          .send({
            success: false,
            error:
              savedMapping.status === "character_forbidden"
                ? "Character not found or access denied"
                : "Agent or character is already mapped",
          });
      }
      invalidateAgentMappingCache(characterId, accountId);
      primeAgentMappingCache(savedMapping.mapping);

      // Create the agent
      const agentId = await agentManager.createAgent({
        characterId,
        accountId,
        name,
        autoStart: true,
      });

      const agentInfo = agentManager.getAgentInfo(agentId);

      console.log(`[AgentRoutes] ✅ Created agent via ElizaOS API: ${name}`);

      return reply.send({
        success: true,
        data: {
          agent: {
            id: agentId,
            name: agentInfo?.name || name,
            status:
              agentInfo?.state === "running" ? "active" : agentInfo?.state,
            character: characterJson,
            createdAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to create agent:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create agent",
      });
    }
  });

  const maskSecretValues = (
    secrets: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!secrets) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      out[key] = value ? "***" : "";
    }
    return out;
  };

  const mergeAgentUpdatePayload = (
    current: AgentCharacterConfig | null,
    body: Record<string, unknown>,
  ): AgentCharacterConfig => {
    const base: AgentCharacterConfig = current ?? { name: "Agent" };
    const nestedChar =
      body.character !== undefined &&
      typeof body.character === "object" &&
      body.character !== null
        ? (body.character as Record<string, unknown>)
        : {};

    const src: Record<string, unknown> = { ...nestedChar };
    for (const [key, value] of Object.entries(body)) {
      if (key !== "character") {
        src[key] = value;
      }
    }

    const next: AgentCharacterConfig = { ...base };

    if (typeof src.name === "string" && src.name.trim()) {
      next.name = src.name.trim();
    }

    if (typeof src.username === "string") {
      next.username = src.username;
    }

    if (typeof src.system === "string") {
      next.system = src.system;
    }

    if (src.bio !== undefined) {
      if (Array.isArray(src.bio)) {
        next.bio = src.bio.filter((x): x is string => typeof x === "string");
      } else if (typeof src.bio === "string") {
        next.bio = src.bio
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      }
    }

    if (Array.isArray(src.lore)) {
      next.lore = src.lore.filter((x): x is string => typeof x === "string");
    }

    if (Array.isArray(src.topics)) {
      next.topics = src.topics.filter(
        (x): x is string => typeof x === "string",
      );
    }

    if (Array.isArray(src.adjectives)) {
      next.adjectives = src.adjectives.filter(
        (x): x is string => typeof x === "string",
      );
    }

    const mp = src.modelProvider;
    if (mp === "openai" || mp === "anthropic" || mp === "groq") {
      next.modelProvider = mp;
    }

    if (
      src.style !== undefined &&
      typeof src.style === "object" &&
      src.style !== null
    ) {
      next.style = src.style as AgentCharacterConfig["style"];
    }

    if (
      src.settings !== undefined &&
      typeof src.settings === "object" &&
      src.settings !== null
    ) {
      const st = src.settings as Record<string, unknown> & {
        secrets?: Record<string, string>;
      };
      const prevSettings = base.settings ?? {};
      next.settings = { ...prevSettings, ...st };
      if (st.secrets !== undefined && typeof st.secrets === "object") {
        next.settings.secrets = {
          ...(prevSettings.secrets ?? {}),
          ...(st.secrets as Record<string, string>),
        };
      }
    }

    return next;
  };

  const buildSettingsPayload = (
    accountId: string,
    characterId: string,
    cfg: AgentCharacterConfig | null,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const merged: Record<string, unknown> = {
      accountId,
      characterId,
      ...extras,
    };
    if (cfg?.settings) {
      Object.assign(merged, cfg.settings);
      const masked = maskSecretValues(cfg.settings.secrets);
      merged.secrets = masked ?? cfg.settings.secrets;
    }
    return merged;
  };

  const agentDetailFromEmbedded = (
    routeAgentId: string,
    info: EmbeddedAgentInfo,
    cfg: AgentCharacterConfig | null,
  ) => {
    const settingsOut = buildSettingsPayload(
      info.accountId,
      info.characterId,
      cfg,
    );
    return {
      id: routeAgentId,
      name: info.name,
      status: info.state === "running" ? "active" : info.state,
      username: cfg?.username,
      bio: cfg?.bio,
      lore: cfg?.lore,
      topics: cfg?.topics,
      adjectives: cfg?.adjectives,
      style: cfg?.style,
      system: cfg?.system,
      settings: settingsOut,
      character: {
        name: info.name,
        settings: settingsOut,
      },
      createdAt: new Date(info.startedAt).toISOString(),
      updatedAt: new Date(info.lastActivity).toISOString(),
    };
  };

  /**
   * If the user has an agent_mappings row but AgentManager never created an instance
   * (agent not started yet), create a stopped embedded agent so dashboard PATCH/GET works.
   */
  const tryEnsureEmbeddedAgentFromDashboardMapping = async (
    routeAgentId: string,
    effectiveCharacterId: string,
  ): Promise<boolean> => {
    const db = getDatabaseDb();
    if (!db) {
      return false;
    }

    const { getAgentManager } = await import("../../eliza/index.js");
    const agentManager = getAgentManager();
    if (!agentManager || agentManager.hasAgent(effectiveCharacterId)) {
      return false;
    }

    let mapping: AgentMappingRecord | null = await getAgentMappingById(
      db,
      routeAgentId,
    );
    if (!mapping || mapping.characterId !== effectiveCharacterId) {
      mapping = await getAgentMappingByCharacterId(db, effectiveCharacterId);
    }
    if (!mapping || mapping.characterId !== effectiveCharacterId) {
      return false;
    }

    try {
      await agentManager.createAgent({
        characterId: mapping.characterId,
        accountId: mapping.accountId,
        name: mapping.agentName,
        autoStart: false,
      });
      console.log(
        `[AgentRoutes] Ensured embedded agent for character ${mapping.characterId} (dashboard id ${routeAgentId})`,
      );
      return true;
    } catch (error) {
      console.error(
        "[AgentRoutes] Failed to ensure embedded agent from mapping:",
        error,
      );
      return false;
    }
  };

  /**
   * GET /api/agents/:agentId
   *
   * Get agent details (ElizaOS-compatible).
   * Used by AgentSettings and character editor.
   *
   * Response:
   * {
   *   success: true,
   *   data: {
   *     agent: { id, name, status, character, ... }
   *   }
   * }
   */
  fastify.get(
    "/api/agents/:agentId",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager, getRunningAgents } =
          await import("../../eliza/index.js");
        const agentManager = getAgentManager();
        const runningModelAgents = getRunningAgents() as Map<
          string,
          {
            config: { displayName: string; provider: string; model: string };
            characterId: string;
            accountId: string;
            service?: {
              getGameState?: () => {
                health?: number;
                maxHealth?: number;
                position?: [number, number, number] | null;
              } | null;
            };
          }
        >;

        const params = request.params as { agentId: string };
        const routeAgentId = params.agentId;

        const effectiveCharacterId =
          await resolveDashboardAgentCharacterId(routeAgentId);
        if (!effectiveCharacterId) {
          return reply.status(404).send({
            success: false,
            error: "Agent not found",
          });
        }

        const findRunningForCharacter = (cid: string) => {
          for (const [, agent] of runningModelAgents) {
            if (agent.characterId === cid) {
              return agent;
            }
          }
          return null;
        };

        const embeddedInfo = agentManager?.getAgentInfo(effectiveCharacterId);
        if (embeddedInfo) {
          const cfg =
            agentManager?.getAgentCharacterConfig(effectiveCharacterId);
          return reply.send({
            success: true,
            data: {
              agent: agentDetailFromEmbedded(
                routeAgentId,
                embeddedInfo,
                cfg ?? null,
              ),
            },
          });
        }

        const running = findRunningForCharacter(effectiveCharacterId);
        if (running) {
          const cfg =
            agentManager?.getAgentCharacterConfig(effectiveCharacterId);
          const gameState = running.service?.getGameState?.() ?? null;
          const settingsOut = buildSettingsPayload(
            running.accountId,
            running.characterId,
            cfg ?? null,
            {
              provider: running.config.provider,
              model: running.config.model,
              health: gameState?.health ?? null,
              maxHealth: gameState?.maxHealth ?? null,
              position: gameState?.position ?? null,
            },
          );
          return reply.send({
            success: true,
            data: {
              agent: {
                id: routeAgentId,
                name: running.config.displayName,
                status: "active",
                username: cfg?.username,
                bio: cfg?.bio,
                lore: cfg?.lore,
                topics: cfg?.topics,
                adjectives: cfg?.adjectives,
                style: cfg?.style,
                system: cfg?.system,
                settings: settingsOut,
                character: {
                  name: running.config.displayName,
                  settings: settingsOut,
                },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
          });
        }

        return reply.status(404).send({
          success: false,
          error: "Agent not found",
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to get agent:", error);
        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : "Failed to get agent",
        });
      }
    },
  );

  /**
   * PUT / PATCH /api/agents/:agentId
   *
   * Update agent (ElizaOS-compatible).
   * Used by AgentSettings (PATCH) to update character config.
   */
  const handleAgentElizaUpdate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      const params = request.params as { agentId: string };
      const routeAgentId = params.agentId;
      const rawBody = request.body;
      const body: Record<string, unknown> =
        rawBody !== null &&
        typeof rawBody === "object" &&
        !Array.isArray(rawBody)
          ? (rawBody as Record<string, unknown>)
          : {};

      const effectiveCharacterId =
        await resolveDashboardAgentCharacterId(routeAgentId);
      if (!effectiveCharacterId) {
        await reply.status(404).send({
          success: false,
          error: "Not found",
        });
        return;
      }

      const { getAgentManager } = await import("../../eliza/index.js");
      const agentManager = getAgentManager();
      if (!agentManager) {
        await reply.status(503).send({
          success: false,
          error: "Agent system not initialized",
        });
        return;
      }

      if (!agentManager.hasAgent(effectiveCharacterId)) {
        await tryEnsureEmbeddedAgentFromDashboardMapping(
          routeAgentId,
          effectiveCharacterId,
        );
      }

      if (!agentManager.hasAgent(effectiveCharacterId)) {
        await reply.status(404).send({
          success: false,
          error: "Not found",
        });
        return;
      }

      const mutation = await executeDisruptiveAgentMutation(
        request,
        reply,
        async (mapping) => {
          if (mapping.characterId !== effectiveCharacterId) {
            throw new Error("agent_mapping_identity_changed");
          }
          const current =
            agentManager.getAgentCharacterConfig(effectiveCharacterId);
          const merged = mergeAgentUpdatePayload(current, body);
          await agentManager.updateAgentCharacterConfig(
            effectiveCharacterId,
            merged,
          );
        },
      );
      if (!mutation) return;

      await reply.send({
        success: true,
        message: "Agent updated",
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to update agent:", error);
      await reply.status(500).send({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update agent",
      });
    }
  };

  fastify.put("/api/agents/:agentId", {
    preHandler: requireOwnedAgentMutation,
    handler: handleAgentElizaUpdate,
  });
  fastify.patch("/api/agents/:agentId", {
    preHandler: requireOwnedAgentMutation,
    handler: handleAgentElizaUpdate,
  });

  /**
   * DELETE /api/agents/:agentId
   *
   * Delete an agent (ElizaOS-compatible).
   */
  fastify.delete(
    "/api/agents/:agentId",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.removeAgent(mapping.characterId);
          },
          true,
        );
        if (!mutation) return;
        invalidateAgentMappingCache(
          mutation.mapping.agentId,
          mutation.mapping.accountId,
        );
        const { getStreamingDuelScheduler } =
          await import("../../systems/StreamingDuelScheduler/index.js");
        getStreamingDuelScheduler()?.applyStreamingDuelParticipation(
          mutation.mapping.characterId,
          false,
        );

        return reply.send({
          success: true,
          message: "Agent deleted",
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to delete agent:", error);
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to delete agent",
        });
      }
    },
  );

  /**
   * POST /api/agents/:agentId/start
   *
   * Start an agent (ElizaOS-compatible).
   * Used by DashboardScreen startAgent function.
   */
  fastify.post(
    "/api/agents/:agentId/start",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            if (!agentManager.hasAgent(mapping.characterId)) {
              await agentManager.createAgent({
                characterId: mapping.characterId,
                accountId: mapping.accountId,
                name: mapping.agentName,
                autoStart: true,
              });
            }
            await agentManager.startAgent(mapping.characterId);
            return agentManager.getAgentInfo(mapping.characterId);
          },
        );
        if (!mutation) return;
        const agentInfo = mutation.value;

        console.log(
          `[AgentRoutes] ✅ Started agent ${mutation.mapping.characterId}`,
        );

        return reply.send({
          success: true,
          data: {
            agent: agentInfo
              ? {
                  id: agentInfo.agentId,
                  name: agentInfo.name,
                  status: "active",
                }
              : { id: mutation.mapping.characterId, status: "active" },
          },
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to start agent:", error);
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to start agent",
        });
      }
    },
  );

  /**
   * POST /api/agents/:agentId/stop
   *
   * Stop an agent (ElizaOS-compatible).
   * Used by DashboardScreen stopAgent function.
   */
  fastify.post(
    "/api/agents/:agentId/stop",
    { preHandler: requireOwnedAgentMutation },
    async (request, reply) => {
      try {
        const { getAgentManager } = await import("../../eliza/index.js");
        const agentManager = getAgentManager();

        const params = request.params as { agentId: string };
        const { agentId } = params;

        if (!agentManager) {
          return reply.status(503).send({
            success: false,
            error: "Agent system not initialized",
          });
        }

        const mutation = await executeDisruptiveAgentMutation(
          request,
          reply,
          async (mapping) => {
            await agentManager.stopAgent(mapping.characterId);
          },
        );
        if (!mutation) return;
        const agentInfo = agentManager.getAgentInfo(
          mutation.mapping.characterId,
        );

        console.log(`[AgentRoutes] ✅ Stopped agent ${agentId}`);

        return reply.send({
          success: true,
          data: {
            agent: agentInfo
              ? {
                  id: agentInfo.agentId,
                  name: agentInfo.name,
                  status: "stopped",
                }
              : { id: agentId, status: "stopped" },
          },
        });
      } catch (error) {
        console.error("[AgentRoutes] ❌ Failed to stop agent:", error);
        return reply.status(500).send({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to stop agent",
        });
      }
    },
  );

  /**
   * GET /api/agents/:agentId/logs
   *
   * Get agent logs (ElizaOS-compatible).
   * Returns empty logs for now - would need log storage.
   */
  fastify.get("/api/agents/:agentId/logs", async (request, reply) => {
    try {
      const params = request.params as { agentId: string };
      const { agentId } = params;

      if (!agentId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required parameter: agentId",
        });
      }

      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Invalid or missing authentication token",
        });
      }

      const db = getDatabaseDb();
      if (!db) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Database system not available",
        });
      }

      const mapping = await getAgentMappingById(db, agentId);
      if (!mapping) {
        return reply.status(404).send({
          success: false,
          error: "Agent not found",
        });
      }

      if (mapping.accountId !== verifiedUserId) {
        return reply.status(403).send({
          success: false,
          error: "You do not have permission to access this agent",
        });
      }

      return reply.status(501).send({
        success: false,
        error: "Agent log storage is not configured",
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to get agent logs:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get agent logs",
      });
    }
  });

  /**
   * GET /api/agents/:agentId/panels
   *
   * Get agent dynamic panels (ElizaOS-compatible).
   * Returns empty panels for now.
   */
  fastify.get("/api/agents/:agentId/panels", async (request, reply) => {
    try {
      const params = request.params as { agentId: string };
      const { agentId } = params;

      if (!agentId) {
        return reply.status(400).send({
          success: false,
          error: "Missing required parameter: agentId",
        });
      }

      const verifiedUserId = await getVerifiedUserId(request);
      if (!verifiedUserId) {
        return reply.status(401).send({
          success: false,
          error: "Invalid or missing authentication token",
        });
      }

      const db = getDatabaseDb();
      if (!db) {
        console.error("[AgentRoutes] DatabaseSystem not available");
        return reply.status(500).send({
          success: false,
          error: "Database system not available",
        });
      }

      const mapping = await getAgentMappingById(db, agentId);
      if (!mapping) {
        return reply.status(404).send({
          success: false,
          error: "Agent not found",
        });
      }

      if (mapping.accountId !== verifiedUserId) {
        return reply.status(403).send({
          success: false,
          error: "You do not have permission to access this agent",
        });
      }

      return reply.send({
        success: true,
        panels: [],
      });
    } catch (error) {
      console.error("[AgentRoutes] ❌ Failed to get agent panels:", error);
      return reply.status(500).send({
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get agent panels",
      });
    }
  });

  /**
   * GET /api/server/health
   *
   * ElizaOS server health check.
   * Used by SystemStatus component.
   */
  fastify.get("/api/server/health", async (_request, reply) => {
    try {
      const { getAgentManager } = await import("../../eliza/index.js");
      const agentManager = getAgentManager();

      const agents = agentManager?.getAllAgents() || [];
      const runningCount = agents.filter((a) => a.state === "running").length;

      return reply.send({
        status: "healthy",
        timestamp: new Date().toISOString(),
        agents: {
          total: agents.length,
          running: runningCount,
        },
      });
    } catch (error) {
      return reply.status(500).send({
        status: "unhealthy",
        error: "Agent health check failed",
      });
    }
  });

  console.log("[AgentRoutes] ✅ ElizaOS-compatible API routes registered");
}
