import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isCanonicalSolanaAddress,
  registerProxyRoutes,
  resolveSolanaProxyCluster,
} from "../../routes/proxy-routes.js";

const openServers: FastifyInstance[] = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function createProxyServer(
  nodeEnv = "production",
): Promise<FastifyInstance> {
  const server = Fastify();
  openServers.push(server);
  await server.register(fastifyWebSocket);
  registerProxyRoutes(server, { nodeEnv });
  return server;
}

describe("SOL-only proxy policy", () => {
  it("allows only mainnet in production-like environments", () => {
    expect(resolveSolanaProxyCluster(undefined, "mainnet-beta", true)).toBe(
      "mainnet-beta",
    );
    expect(resolveSolanaProxyCluster("mainnet", "mainnet-beta", true)).toBe(
      "mainnet-beta",
    );

    for (const cluster of ["devnet", "testnet", "localnet", "ethereum"]) {
      expect(
        resolveSolanaProxyCluster(cluster, "mainnet-beta", true),
        cluster,
      ).toBeNull();
    }

    expect(resolveSolanaProxyCluster("devnet", "mainnet-beta", false)).toBe(
      "devnet",
    );
  });

  it("accepts only canonical 32-byte Solana addresses", () => {
    expect(
      isCanonicalSolanaAddress("So11111111111111111111111111111111111111112"),
    ).toBe(true);
    expect(isCanonicalSolanaAddress("22222222222222222222222222222222")).toBe(
      false,
    );
    expect(isCanonicalSolanaAddress("not-a-solana-address")).toBe(false);
  });

  it("requires an exact browser Origin before spending an RPC request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const server = await createProxyServer();
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
      params: [],
    };

    for (const origin of [
      undefined,
      "https://hyperia.gg.attacker.example",
      "https://attacker.up.railway.app",
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/proxy/solana/rpc",
        headers: origin ? { origin } : undefined,
        payload,
      });
      expect(response.statusCode, origin || "missing Origin").toBe(403);
      expect(response.json()).toEqual({ error: "Forbidden" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-mainnet clusters and malformed or excessive RPC batches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const server = await createProxyServer();
    const headers = { origin: "https://hyperbet.win" };

    const devnet = await server.inject({
      method: "POST",
      url: "/api/proxy/solana/rpc?cluster=devnet",
      headers,
      payload: { jsonrpc: "2.0", id: 1, method: "getHealth" },
    });
    expect(devnet.statusCode).toBe(400);
    expect(devnet.json()).toEqual({ error: "Unsupported Solana cluster" });

    for (const payload of [
      { id: 1, method: "getHealth" },
      { jsonrpc: "2.0", id: 1, method: "invalid-method" },
      [{ jsonrpc: "2.0", id: 1, method: "getHealth" }, "not-an-rpc-request"],
      Array.from({ length: 51 }, (_, id) => ({
        jsonrpc: "2.0",
        id,
        method: "getHealth",
      })),
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/proxy/solana/rpc",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Invalid JSON-RPC payload" });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays a valid mainnet request without exposing the upstream URL", async () => {
    let observedUpstreamUrl = "";
    let observedMethod = "";
    const fetchMock = vi.fn(
      async (input: string | URL | Request, options?: RequestInit) => {
        observedUpstreamUrl = String(input);
        observedMethod = options?.method || "";
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 7, result: "ok" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HELIUS_API_KEY", "provider-secret");
    const server = await createProxyServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/proxy/solana/rpc",
      headers: { origin: "https://hyperbet.win" },
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "sendTransaction",
        params: ["signed-transaction"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observedUpstreamUrl).toContain("mainnet.helius-rpc.com");
    expect(observedUpstreamUrl).toContain("provider-secret");
    expect(observedMethod).toBe("POST");
    expect(response.body).not.toContain("provider-secret");
  });

  it("validates Birdeye inputs before calling the paid provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BIRDEYE_API_KEY", "provider-secret");
    const server = await createProxyServer();

    const invalid = await server.inject({
      method: "GET",
      url: "/api/proxy/birdeye/price?address=not-a-solana-address",
      headers: { origin: "https://hyperbet.win" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "Invalid address parameter" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers bounded HTTP and WebSocket proxy policies", async () => {
    const observed = new Map<
      string,
      {
        bodyLimit?: number;
        rateMax?: number;
        hasPreHandler: boolean;
        hasPreValidation: boolean;
      }
    >();
    const server = Fastify();
    openServers.push(server);
    await server.register(fastifyWebSocket);
    server.addHook("onRoute", (route) => {
      const rateLimit = route.config?.rateLimit as { max?: number } | undefined;
      observed.set(route.url, {
        bodyLimit: route.bodyLimit,
        rateMax: rateLimit?.max,
        hasPreHandler: Boolean(route.preHandler),
        hasPreValidation: Boolean(route.preValidation),
      });
    });
    registerProxyRoutes(server, { nodeEnv: "production" });

    expect(observed.get("/api/proxy/solana/rpc")).toMatchObject({
      bodyLimit: 256 * 1024,
      rateMax: 300,
      hasPreHandler: true,
    });
    expect(observed.get("/api/proxy/solana/ws")).toMatchObject({
      rateMax: 20,
      hasPreValidation: true,
    });
    expect(observed.get("/api/proxy/birdeye/price")).toMatchObject({
      rateMax: 60,
      hasPreHandler: true,
    });
  });
});
