import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const verifyPrivyToken = vi.hoisted(() => vi.fn());

vi.mock("../privy-auth.js", () => ({
  verifyPrivyToken,
}));

import { requirePrivyRequestUser } from "../http-auth.js";

const openServers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  verifyPrivyToken.mockReset();
});

function createServer(): FastifyInstance {
  const server = Fastify();
  openServers.push(server);
  server.get("/private/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const authenticatedUserId = await requirePrivyRequestUser(
      request,
      reply,
      userId,
    );
    if (!authenticatedUserId) return;
    return reply.send({ authenticatedUserId });
  });
  return server;
}

describe("HTTP Privy authentication boundary", () => {
  it("accepts one exact verified bearer token for the claimed user", async () => {
    verifyPrivyToken.mockResolvedValue({
      isVerified: true,
      privyUserId: "account-a",
    });
    const response = await createServer().inject({
      method: "GET",
      url: "/private/account-a",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticatedUserId: "account-a" });
    expect(verifyPrivyToken).toHaveBeenCalledWith("valid-token");
  });

  it("fails generically for missing, malformed, unverified, or provider-error credentials", async () => {
    const server = createServer();
    for (const authorization of [
      undefined,
      "Basic credential",
      "Bearer",
      "Bearer token with spaces",
      "Bearer token,second",
      `Bearer ${"x".repeat(16 * 1024 + 1)}`,
    ]) {
      const response = await server.inject({
        method: "GET",
        url: "/private/account-a",
        headers: authorization ? { authorization } : undefined,
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ error: "Unauthorized" });
    }

    verifyPrivyToken.mockResolvedValue(null);
    const unverified = await server.inject({
      method: "GET",
      url: "/private/account-a",
      headers: { authorization: "Bearer unverified" },
    });
    expect(unverified.statusCode).toBe(401);

    verifyPrivyToken.mockRejectedValue(new Error("private provider detail"));
    const providerError = await server.inject({
      method: "GET",
      url: "/private/account-a",
      headers: { authorization: "Bearer provider-error" },
    });
    expect(providerError.statusCode).toBe(401);
    expect(providerError.body).not.toContain("provider detail");
  });

  it("rejects duplicate authorization headers before provider verification", async () => {
    const response = await createServer().inject({
      method: "GET",
      url: "/private/account-a",
      headers: {
        authorization: ["Bearer first", "Bearer second"],
      } as unknown as Record<string, string>,
    });
    expect(response.statusCode).toBe(401);
    expect(verifyPrivyToken).not.toHaveBeenCalled();
  });

  it("distinguishes valid authentication from ownership", async () => {
    verifyPrivyToken.mockResolvedValue({
      isVerified: true,
      privyUserId: "account-b",
    });
    const response = await createServer().inject({
      method: "GET",
      url: "/private/account-a",
      headers: { authorization: "Bearer valid-for-b" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
  });
});
