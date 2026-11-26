import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyPrivyToken = vi.hoisted(() => vi.fn());

vi.mock("../../infrastructure/auth/privy-auth.js", () => ({
  isPrivyEnabled: () => true,
  verifyPrivyToken,
}));

import { registerActionRoutes } from "../routes/action-routes.js";
import { registerCharacterRoutes } from "../routes/character-routes.js";
import { registerLayoutRoutes } from "../routes/layout-routes.js";
import { registerUploadRoutes } from "../routes/upload-routes.js";
import { registerUserRoutes } from "../routes/user-routes.js";

const openServers: FastifyInstance[] = [];

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DISTRIBUTED_RATE_LIMIT_ENABLED", "false");
  verifyPrivyToken.mockImplementation(async (token: string) => ({
    isVerified: true,
    privyUserId: token,
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  verifyPrivyToken.mockReset();
});

function track(server: FastifyInstance): FastifyInstance {
  openServers.push(server);
  return server;
}

function authorization(userId: string) {
  return { authorization: `Bearer ${userId}` };
}

function createDbRecorder() {
  const inserted: unknown[] = [];
  const selection = {
    limit: async () => [],
    offset: async () => [],
    orderBy: async () => [],
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => selection,
      }),
    }),
    insert: () => ({
      values: async (value: unknown) => {
        inserted.push(value);
      },
    }),
  };
  return { db, inserted };
}

describe("mutable HTTP route ownership", () => {
  it("binds account existence checks and creation to the verified Privy user", async () => {
    const { db, inserted } = createDbRecorder();
    const databaseSystem = {
      getDb: () => db,
      getPool: () => null,
      updateUserWallet: vi.fn(),
    };
    const server = track(Fastify());
    registerUserRoutes(server, {
      getSystem: () => databaseSystem,
    } as never);

    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/users/check?accountId=account-a",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongOwner = await server.inject({
      method: "POST",
      url: "/api/users/create",
      headers: authorization("account-b"),
      payload: {
        accountId: "account-a",
        username: "alpha_user",
        wallet: "wallet-a",
      },
    });
    expect(wrongOwner.statusCode).toBe(403);
    expect(inserted).toHaveLength(0);

    const owner = await server.inject({
      method: "POST",
      url: "/api/users/create",
      headers: authorization("account-a"),
      payload: {
        accountId: "account-a",
        username: "alpha_user",
        wallet: "wallet-a",
      },
    });
    expect(owner.statusCode).toBe(200);
    expect(inserted).toHaveLength(1);
  });

  it("keeps private layout data behind exact account ownership", async () => {
    const { db } = createDbRecorder();
    const server = track(Fastify());
    registerLayoutRoutes(server, {
      getSystem: () => ({ getDb: () => db }),
    } as never);

    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/layouts?userId=account-a",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongOwner = await server.inject({
      method: "GET",
      url: "/api/layouts?userId=account-a",
      headers: authorization("account-b"),
    });
    expect(wrongOwner.statusCode).toBe(403);

    const owner = await server.inject({
      method: "GET",
      url: "/api/layouts?userId=account-a",
      headers: authorization("account-a"),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({ success: true, presets: [] });
  });

  it("protects character creation, inspection, and destructive mutation", async () => {
    const deleteCharacter = vi.fn(async () => true);
    const createCharacter = vi.fn(async () => true);
    const databaseSystem = {
      createCharacter,
      deleteCharacter,
      getCharactersAsync: vi.fn(async (accountId: string) =>
        accountId === "account-a" ? [{ id: "character-a" }] : [],
      ),
      getCharacterSkills: vi.fn(async () => ({ attack: { level: 5, xp: 10 } })),
      updateCharacterIsAgent: vi.fn(async () => true),
    };
    const server = track(Fastify());
    registerCharacterRoutes(
      server,
      {
        entities: { get: () => undefined },
        getSystem: () => databaseSystem,
        network: { sockets: new Map() },
      } as never,
      { nodeEnv: "production" },
    );

    const fileWriter = await server.inject({
      method: "POST",
      url: "/api/characters",
      payload: { character: {}, filename: "unsafe" },
    });
    expect(fileWriter.statusCode).toBe(404);

    const wrongCreationOwner = await server.inject({
      method: "POST",
      url: "/api/characters/db",
      headers: authorization("account-b"),
      payload: { accountId: "account-a", name: "Alpha" },
    });
    expect(wrongCreationOwner.statusCode).toBe(403);
    expect(createCharacter).not.toHaveBeenCalled();

    const privateRead = await server.inject({
      method: "GET",
      url: "/api/characters/character-a/skills",
      headers: authorization("account-b"),
    });
    expect(privateRead.statusCode).toBe(403);

    const wrongDelete = await server.inject({
      method: "DELETE",
      url: "/api/characters/character-a",
      headers: authorization("account-b"),
    });
    expect(wrongDelete.statusCode).toBe(403);
    expect(deleteCharacter).not.toHaveBeenCalled();

    const ownerDelete = await server.inject({
      method: "DELETE",
      url: "/api/characters/character-a",
      headers: authorization("account-a"),
    });
    expect(ownerDelete.statusCode).toBe(200);
    expect(deleteCharacter).toHaveBeenCalledWith("character-a");
  });

  it("executes actions only for a character owned by the verified user", async () => {
    const execute = vi.fn(async (_name, context) => context);
    const world = {
      actionRegistry: {
        execute,
        getAll: () => [],
        getAvailable: () => [],
      },
      getSystem: () => ({
        getCharactersAsync: async (accountId: string) =>
          accountId === "account-a" ? [{ id: "character-a" }] : [],
      }),
    };
    const server = track(Fastify());
    registerActionRoutes(server, world as never);

    const unauthenticated = await server.inject({
      method: "POST",
      url: "/api/actions/move?playerId=character-a",
      payload: { params: { x: 1 } },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const otherCharacter = await server.inject({
      method: "POST",
      url: "/api/actions/move?playerId=character-b",
      headers: authorization("account-a"),
      payload: { params: { x: 1 } },
    });
    expect(otherCharacter.statusCode).toBe(403);
    expect(execute).not.toHaveBeenCalled();

    const owner = await server.inject({
      method: "POST",
      url: "/api/actions/move?playerId=character-a&world=attacker-value",
      headers: authorization("account-a"),
      payload: { params: { x: 1 } },
    });
    expect(owner.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    const context = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(context.playerId).toBe("character-a");
    expect(context.world).toBe(world);
    expect(JSON.stringify(context)).not.toContain("attacker-value");
  });

  it("does not register legacy filesystem upload routes in production", async () => {
    const server = track(Fastify());
    registerUploadRoutes(server, { nodeEnv: "production" } as never);
    const response = await server.inject({
      method: "GET",
      url: "/api/upload-check?filename=abc123.png",
    });
    expect(response.statusCode).toBe(404);
  });
});
