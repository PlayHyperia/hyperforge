import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MappingRow = {
  accountId: string;
  agentId: string;
  agentName: string;
  characterId: string;
  streamingDuelEnabled?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

const { agentMappingsTable, usersTable, charactersTable } = vi.hoisted(() => ({
  agentMappingsTable: {
    __table: "agentMappings",
    accountId: "accountId",
    agentId: "agentId",
    agentName: "agentName",
    characterId: "characterId",
  },
  usersTable: {
    __table: "users",
    id: "id",
  },
  charactersTable: {
    __table: "characters",
    accountId: "accountId",
    id: "id",
  },
}));

vi.mock("../../database/schema.js", () => ({
  agentMappings: agentMappingsTable,
  characters: charactersTable,
  users: usersTable,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (column: string, value: unknown) => ({ column, value }),
  };
});

vi.mock("../../eliza/index.js", () => ({
  getAgentManager: () => null,
  getRunningAgents: () => new Map(),
}));

vi.mock("../../shared/utils.js", () => ({
  createJWT: vi.fn(),
  verifyJWT: vi.fn(async (token: string) => ({ userId: token })),
}));

vi.mock("../../infrastructure/auth/privy-auth.js", () => ({
  isPrivyEnabled: () => false,
  verifyPrivyToken: vi.fn(),
}));

import { registerAgentRoutes } from "../routes/agent-routes";

function createReplyRecorder() {
  return {
    payload: undefined as unknown,
    statusCode: 200,
    send(payload: unknown) {
      this.payload = payload;
      return payload;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

function createFastifyRecorder() {
  const routes = new Map<string, Function>();
  const preHandlers = new Map<string, Function>();
  const register = (
    method: string,
    path: string,
    optionsOrHandler: Function | { handler?: Function; preHandler?: Function },
    maybeHandler?: Function,
  ) => {
    if (typeof optionsOrHandler === "function") {
      routes.set(`${method} ${path}`, optionsOrHandler);
      return;
    }
    const handler = maybeHandler ?? optionsOrHandler.handler;
    if (handler) routes.set(`${method} ${path}`, handler);
    if (optionsOrHandler.preHandler) {
      preHandlers.set(`${method} ${path}`, optionsOrHandler.preHandler);
    }
  };
  const fastify = {
    delete(
      path: string,
      optionsOrHandler:
        Function | { handler?: Function; preHandler?: Function },
      handler?: Function,
    ) {
      register("DELETE", path, optionsOrHandler, handler);
      return this;
    },
    get(
      path: string,
      optionsOrHandler:
        Function | { handler?: Function; preHandler?: Function },
      handler?: Function,
    ) {
      register("GET", path, optionsOrHandler, handler);
      return this;
    },
    patch(
      path: string,
      optionsOrHandler:
        Function | { handler?: Function; preHandler?: Function },
      handler?: Function,
    ) {
      register("PATCH", path, optionsOrHandler, handler);
      return this;
    },
    post(
      path: string,
      optionsOrHandler:
        Function | { handler?: Function; preHandler?: Function },
      handler?: Function,
    ) {
      register("POST", path, optionsOrHandler, handler);
      return this;
    },
    put(
      path: string,
      optionsOrHandler:
        Function | { handler?: Function; preHandler?: Function },
      handler?: Function,
    ) {
      register("PUT", path, optionsOrHandler, handler);
      return this;
    },
  };

  return {
    fastify: fastify as never,
    preHandlers,
    routes,
  };
}

function createMockDatabase(
  initialMappings: MappingRow[],
  activeMarketCharacterIds: ReadonlySet<string> = new Set(),
) {
  const state = {
    mappings: [...initialMappings],
  };

  const db = {
    delete: (table: { __table: string }) => ({
      where: async (condition: {
        column: keyof MappingRow;
        value: unknown;
      }) => {
        if (table.__table === "agentMappings") {
          state.mappings = state.mappings.filter(
            (mapping) => mapping[condition.column] !== condition.value,
          );
        }
        return undefined;
      },
    }),
    insert: (table: { __table: string }) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (config: {
          set: Record<string, unknown>;
          target: keyof MappingRow;
        }) => {
          if (table.__table !== "agentMappings") {
            return undefined;
          }

          const nextMapping = values as MappingRow;
          const existingIndex = state.mappings.findIndex(
            (mapping) => mapping[config.target] === nextMapping[config.target],
          );

          if (existingIndex >= 0) {
            state.mappings[existingIndex] = {
              ...state.mappings[existingIndex],
              ...(config.set as Partial<MappingRow>),
            };
            return undefined;
          }

          state.mappings.push(nextMapping);
          return undefined;
        },
      }),
    }),
    query: {
      characters: {
        findFirst: async () => null,
      },
    },
    select: () => ({
      from: (table: { __table: string }) => ({
        where: async (condition: {
          column: keyof MappingRow;
          value: unknown;
        }) => {
          if (table.__table === "agentMappings") {
            return state.mappings.filter(
              (mapping) => mapping[condition.column] === condition.value,
            );
          }
          return [];
        },
      }),
    }),
  };

  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.includes("pg_advisory_xact_lock")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT "roles" FROM "users"')) {
        return { rows: [{ roles: "player" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id") && sql.includes("FROM characters")) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (
        sql.includes('FROM "agent_mappings"') &&
        sql.includes('WHERE "agent_id" = $1') &&
        sql.includes("FOR UPDATE")
      ) {
        const mapping = state.mappings.find(
          (candidate) => candidate.agentId === params[0],
        );
        return { rows: mapping ? [mapping] : [], rowCount: mapping ? 1 : 0 };
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("locked")) {
        return {
          rows: [{ locked: activeMarketCharacterIds.has(String(params[0])) }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE "agent_mappings"') && params.length === 2) {
        const mapping = state.mappings.find(
          (candidate) => candidate.agentId === params[0],
        );
        if (!mapping) return { rows: [], rowCount: 0 };
        mapping.agentName = String(params[1]);
        return { rows: [mapping], rowCount: 1 };
      }
      if (sql.includes('UPDATE "agent_mappings"') && params.length === 3) {
        const mapping = state.mappings.find(
          (candidate) =>
            candidate.agentId === params[0] &&
            candidate.accountId === params[1],
        );
        if (!mapping) return { rows: [], rowCount: 0 };
        mapping.streamingDuelEnabled = params[2] === true;
        return { rows: [mapping], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "agent_mappings"')) {
        const mapping: MappingRow = {
          agentId: String(params[0]),
          accountId: String(params[1]),
          characterId: String(params[2]),
          agentName: String(params[3]),
          streamingDuelEnabled: false,
        };
        state.mappings.push(mapping);
        return { rows: [mapping], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM "agent_mappings"')) {
        const index = state.mappings.findIndex(
          (candidate) =>
            candidate.agentId === params[0] &&
            candidate.accountId === params[1],
        );
        if (index < 0) return { rows: [], rowCount: 0 };
        const [mapping] = state.mappings.splice(index, 1);
        return { rows: mapping ? [mapping] : [], rowCount: mapping ? 1 : 0 };
      }
      throw new Error(`Unexpected SQL in agent route test: ${sql}`);
    },
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params: unknown[] = []) =>
      client.query(sql, params),
    ),
  };

  return { db, pool, state };
}

function setupRoutes(
  initialMappings: MappingRow[],
  activeMarketCharacterIds: ReadonlySet<string> = new Set(),
) {
  const { fastify, preHandlers, routes } = createFastifyRecorder();
  const { db, pool, state } = createMockDatabase(
    initialMappings,
    activeMarketCharacterIds,
  );
  const world = {
    getSystem: (name: string) =>
      name === "database" ? { db, getPool: () => pool } : undefined,
  };

  registerAgentRoutes(fastify, world as never);

  return {
    createCredentials: routes.get("POST /api/agents/credentials")!,
    deleteMapping: routes.get("DELETE /api/agents/mappings/:agentId")!,
    getMapping: routes.get("GET /api/agents/mapping/:agentId")!,
    listMappings: routes.get("GET /api/agents/mappings/:accountId")!,
    saveMapping: routes.get("POST /api/agents/mappings")!,
    setStreamingDuelPreference: routes.get(
      "PATCH /api/agents/mappings/:agentId/streaming-duel",
    )!,
    stopAgentPreHandler: preHandlers.get("POST /api/agents/:agentId/stop")!,
    walletAuth: routes.get("POST /api/agents/wallet-auth")!,
    debugResources: routes.get("GET /api/debug/resources")!,
    preHandlers,
    state,
  };
}

describe("agent route mapping cache", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refreshes display metadata without changing ownership or persisted opt-in", async () => {
    const { getMapping, listMappings, saveMapping, state } = setupRoutes([
      {
        agentId: "agent-1",
        accountId: "account-old",
        characterId: "character-1",
        agentName: "Alpha",
        streamingDuelEnabled: true,
      },
    ]);

    const firstListReply = createReplyRecorder();
    await listMappings(
      {
        headers: { authorization: "Bearer account-old" },
        params: { accountId: "account-old" },
      } as never,
      firstListReply as never,
    );
    expect(firstListReply.payload).toMatchObject({
      agentIds: ["agent-1", "character-1"],
      count: 2,
      success: true,
    });

    const saveReply = createReplyRecorder();
    await saveMapping(
      {
        headers: { authorization: "Bearer account-old" },
        body: {
          agentId: "agent-1",
          accountId: "account-old",
          characterId: "character-1",
          agentName: "Beta",
        },
      } as never,
      saveReply as never,
    );
    expect(saveReply.payload).toMatchObject({ success: true });
    expect(state.mappings).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        accountId: "account-old",
        characterId: "character-1",
        agentName: "Beta",
        streamingDuelEnabled: true,
      }),
    ]);

    const refreshedAccountReply = createReplyRecorder();
    await listMappings(
      {
        headers: { authorization: "Bearer account-old" },
        params: { accountId: "account-old" },
      } as never,
      refreshedAccountReply as never,
    );
    expect(refreshedAccountReply.payload).toMatchObject({
      agentIds: ["agent-1", "character-1"],
      count: 2,
      success: true,
    });

    const mappingReply = createReplyRecorder();
    await getMapping(
      { params: { agentId: "agent-1" } } as never,
      mappingReply as never,
    );
    expect(mappingReply.payload).toMatchObject({
      accountId: "account-old",
      agentName: "Beta",
      characterId: "character-1",
      streamingDuelEnabled: true,
      success: true,
    });
  });

  it("invalidates both id and account caches when a mapping is deleted", async () => {
    const { deleteMapping, getMapping, listMappings } = setupRoutes([
      {
        agentId: "agent-1",
        accountId: "account-old",
        characterId: "character-1",
        agentName: "Alpha",
      },
    ]);

    const listReply = createReplyRecorder();
    await listMappings(
      {
        headers: { authorization: "Bearer account-old" },
        params: { accountId: "account-old" },
      } as never,
      listReply as never,
    );
    expect(listReply.payload).toMatchObject({
      agentIds: ["agent-1", "character-1"],
      count: 2,
      success: true,
    });

    const mappingReply = createReplyRecorder();
    await getMapping(
      { params: { agentId: "agent-1" } } as never,
      mappingReply as never,
    );
    expect(mappingReply.payload).toMatchObject({
      agentId: "agent-1",
      success: true,
    });

    const deleteReply = createReplyRecorder();
    await deleteMapping(
      {
        headers: { authorization: "Bearer account-old" },
        params: { agentId: "agent-1" },
      } as never,
      deleteReply as never,
    );
    expect(deleteReply.payload).toMatchObject({ success: true });

    const deletedMappingReply = createReplyRecorder();
    await getMapping(
      { params: { agentId: "agent-1" } } as never,
      deletedMappingReply as never,
    );
    expect(deletedMappingReply.statusCode).toBe(404);
    expect(deletedMappingReply.payload).toMatchObject({
      error: "Agent mapping not found",
      success: false,
    });

    const deletedListReply = createReplyRecorder();
    await listMappings(
      {
        headers: { authorization: "Bearer account-old" },
        params: { accountId: "account-old" },
      } as never,
      deletedListReply as never,
    );
    expect(deletedListReply.payload).toMatchObject({
      agentIds: [],
      count: 0,
      success: true,
    });
  });

  it("clears negative mapping cache entries when a mapping is later created", async () => {
    const { getMapping, saveMapping } = setupRoutes([]);

    const missingReply = createReplyRecorder();
    await getMapping(
      { params: { agentId: "agent-2" } } as never,
      missingReply as never,
    );
    expect(missingReply.statusCode).toBe(404);

    const saveReply = createReplyRecorder();
    await saveMapping(
      {
        headers: { authorization: "Bearer account-new" },
        body: {
          agentId: "agent-2",
          accountId: "account-new",
          characterId: "character-2",
          agentName: "Gamma",
        },
      } as never,
      saveReply as never,
    );
    expect(saveReply.payload).toMatchObject({ success: true });

    const mappingReply = createReplyRecorder();
    await getMapping(
      { params: { agentId: "agent-2" } } as never,
      mappingReply as never,
    );
    expect(mappingReply.statusCode).toBe(200);
    expect(mappingReply.payload).toMatchObject({
      accountId: "account-new",
      agentId: "agent-2",
      agentName: "Gamma",
      characterId: "character-2",
      success: true,
    });
  });

  it("requires authenticated ownership for credential and mapping creation", async () => {
    const { createCredentials, saveMapping } = setupRoutes([]);
    const credentialReply = createReplyRecorder();
    await createCredentials(
      {
        headers: {},
        body: { accountId: "account-a", characterId: "character-a" },
      } as never,
      credentialReply as never,
    );
    expect(credentialReply.statusCode).toBe(401);

    const unauthenticatedReply = createReplyRecorder();
    await saveMapping(
      {
        headers: {},
        body: {
          accountId: "account-a",
          agentId: "agent-a",
          agentName: "A",
          characterId: "character-a",
        },
      } as never,
      unauthenticatedReply as never,
    );
    expect(unauthenticatedReply.statusCode).toBe(401);

    const wrongOwnerReply = createReplyRecorder();
    await saveMapping(
      {
        headers: { authorization: "Bearer account-b" },
        body: {
          accountId: "account-a",
          agentId: "agent-a",
          agentName: "A",
          characterId: "character-a",
        },
      } as never,
      wrongOwnerReply as never,
    );
    expect(wrongOwnerReply.statusCode).toBe(403);
  });

  it("does not let a different owner claim an existing mapping", async () => {
    const { saveMapping, state } = setupRoutes([
      {
        accountId: "account-a",
        agentId: "agent-a",
        agentName: "A",
        characterId: "character-a",
        streamingDuelEnabled: true,
      },
    ]);
    const reply = createReplyRecorder();
    await saveMapping(
      {
        headers: { authorization: "Bearer account-b" },
        body: {
          accountId: "account-b",
          agentId: "agent-a",
          agentName: "Stolen",
          characterId: "character-b",
        },
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(409);
    expect(state.mappings).toEqual([
      expect.objectContaining({
        accountId: "account-a",
        agentName: "A",
        characterId: "character-a",
        streamingDuelEnabled: true,
      }),
    ]);
  });

  it("persists an exact owner opt-in and denies a different account", async () => {
    const { setStreamingDuelPreference, state } = setupRoutes([
      {
        accountId: "account-a",
        agentId: "agent-a",
        agentName: "A",
        characterId: "character-a",
        streamingDuelEnabled: false,
      },
    ]);
    const forbiddenReply = createReplyRecorder();
    await setStreamingDuelPreference(
      {
        headers: { authorization: "Bearer account-b" },
        params: { agentId: "agent-a" },
        body: { streamingDuelEnabled: true },
      } as never,
      forbiddenReply as never,
    );
    expect(forbiddenReply.statusCode).toBe(403);
    expect(state.mappings[0]?.streamingDuelEnabled).toBe(false);

    const ownerReply = createReplyRecorder();
    await setStreamingDuelPreference(
      {
        headers: { authorization: "Bearer account-a" },
        params: { agentId: "agent-a" },
        body: { streamingDuelEnabled: true },
      } as never,
      ownerReply as never,
    );
    expect(ownerReply.payload).toMatchObject({
      success: true,
      characterId: "character-a",
      streamingDuelEnabled: true,
    });
    expect(state.mappings[0]?.streamingDuelEnabled).toBe(true);
  });

  it("rejects opt-out and mapping deletion while competitive truth is active", async () => {
    const { deleteMapping, setStreamingDuelPreference, state } = setupRoutes(
      [
        {
          accountId: "account-a",
          agentId: "agent-a",
          agentName: "A",
          characterId: "character-a",
          streamingDuelEnabled: true,
        },
      ],
      new Set(["character-a"]),
    );
    const preferenceReply = createReplyRecorder();
    await setStreamingDuelPreference(
      {
        headers: { authorization: "Bearer account-a" },
        params: { agentId: "agent-a" },
        body: { streamingDuelEnabled: false },
      } as never,
      preferenceReply as never,
    );
    expect(preferenceReply.statusCode).toBe(409);

    const deletionReply = createReplyRecorder();
    await deleteMapping(
      {
        headers: { authorization: "Bearer account-a" },
        params: { agentId: "agent-a" },
      } as never,
      deletionReply as never,
    );
    expect(deletionReply.statusCode).toBe(409);
    expect(state.mappings).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        streamingDuelEnabled: true,
      }),
    ]);
  });

  it("gates lifecycle mutation on the exact persisted owner", async () => {
    const { stopAgentPreHandler } = setupRoutes([
      {
        accountId: "account-a",
        agentId: "agent-a",
        agentName: "A",
        characterId: "character-a",
        streamingDuelEnabled: false,
      },
    ]);
    const unauthenticatedReply = createReplyRecorder();
    await stopAgentPreHandler(
      { headers: {}, params: { agentId: "agent-a" } } as never,
      unauthenticatedReply as never,
    );
    expect(unauthenticatedReply.statusCode).toBe(401);

    const wrongOwnerReply = createReplyRecorder();
    await stopAgentPreHandler(
      {
        headers: { authorization: "Bearer account-b" },
        params: { agentId: "agent-a" },
      } as never,
      wrongOwnerReply as never,
    );
    expect(wrongOwnerReply.statusCode).toBe(403);

    const ownerReply = createReplyRecorder();
    await stopAgentPreHandler(
      {
        headers: { authorization: "Bearer account-a" },
        params: { agentId: "agent-a" },
      } as never,
      ownerReply as never,
    );
    expect(ownerReply.statusCode).toBe(200);
    expect(ownerReply.payload).toBeUndefined();
  });

  it("does not accept an unproved wallet address outside the no-money diagnostic rail", async () => {
    vi.stubEnv("DUEL_LOCAL_SMOKE_MODE", "false");
    const { walletAuth } = setupRoutes([]);
    const reply = createReplyRecorder();
    await walletAuth(
      {
        body: {
          walletAddress: "attacker-controlled-address",
          walletType: "solana",
        },
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(404);
  });

  it("does not expose world resource coordinates outside the exact local diagnostic rail", async () => {
    vi.stubEnv("DUEL_LOCAL_SMOKE_MODE", "false");
    const { debugResources } = setupRoutes([]);
    const reply = createReplyRecorder();
    await debugResources({} as never, reply as never);
    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({ error: "Not found" });
  });

  it("attaches ownership enforcement to every private agent read surface", async () => {
    const { listMappings, preHandlers } = setupRoutes([
      {
        accountId: "account-a",
        agentId: "agent-a",
        agentName: "A",
        characterId: "character-a",
      },
    ]);
    for (const route of [
      "GET /api/agents/mapping/:agentId",
      "GET /api/agents/:agentId/goal",
      "GET /api/agents/:agentId/quick-actions",
      "GET /api/agents/:agentId/activity",
      "GET /api/agents/:agentId/quests",
      "GET /api/agents/:agentId/thoughts",
      "GET /api/embedded-agents/:characterId",
      "GET /api/embedded-agents/:characterId/state",
      "GET /api/agents/:agentId",
    ]) {
      expect(preHandlers.get(route), route).toBeTypeOf("function");
    }

    const reply = createReplyRecorder();
    await listMappings(
      {
        headers: { authorization: "Bearer account-b" },
        params: { accountId: "account-a" },
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toMatchObject({ error: "Forbidden" });
  });
});
