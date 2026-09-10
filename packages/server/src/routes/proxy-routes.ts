import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket as WsWebSocket } from "ws";
import { PublicKey } from "@solana/web3.js";
import type { ServerConfig } from "../startup/config.js";
import {
  createRequiredBrowserOriginPreHandler,
  isProductionLikeEnvironment,
  resolveAllowedOrigins,
} from "../infrastructure/http/origin-policy.js";

type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

type JsonRpcRequestPayload = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
};

type ProxiedRpcResponse = {
  status: number;
  body: string;
  contentType: string;
};

type CachedRpcResponse = ProxiedRpcResponse & {
  expiresAt: number;
  byteSize: number;
};

const MAX_RPC_REQUEST_BYTES = 256 * 1024;
const MAX_RPC_BATCH_ENTRIES = 50;
const MAX_RPC_METHOD_LENGTH = 128;
const MAX_WS_PROXY_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_PROXY_MESSAGES_PER_MINUTE = 120;
const WS_PROXY_ALLOWED_METHODS = new Set([
  "accountSubscribe",
  "accountUnsubscribe",
  "blockSubscribe",
  "blockUnsubscribe",
  "logsSubscribe",
  "logsUnsubscribe",
  "programSubscribe",
  "programUnsubscribe",
  "rootSubscribe",
  "rootUnsubscribe",
  "signatureSubscribe",
  "signatureUnsubscribe",
  "slotSubscribe",
  "slotUnsubscribe",
  "slotsUpdatesSubscribe",
  "slotsUpdatesUnsubscribe",
  "voteSubscribe",
  "voteUnsubscribe",
]);

function parseEnvInt(
  rawValue: string | undefined,
  fallback: number,
  minValue: number,
): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

const RPC_CACHEABLE_METHODS = new Set<string>([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getBlockTime",
  "getEpochInfo",
  "getEpochSchedule",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getIdentity",
  "getLatestBlockhash",
  "getLeaderSchedule",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPerformanceSamples",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getSlot",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
]);

const RPC_CACHE_TTL_MS_BY_METHOD: Record<string, number> = {
  getLatestBlockhash: 400,
  getBlockHeight: 400,
  getSlot: 400,
  getSignatureStatuses: 700,
  getAccountInfo: 1_000,
  getMultipleAccounts: 1_000,
  getProgramAccounts: 1_000,
  getBalance: 1_000,
  getTokenAccountBalance: 1_000,
  getTokenAccountsByOwner: 1_000,
  getSignaturesForAddress: 1_000,
};

const DEFAULT_RPC_CACHE_TTL_MS = 800;
const MAX_RPC_CACHE_ENTRIES = parseEnvInt(
  process.env.RPC_PROXY_CACHE_MAX_ENTRIES,
  512,
  32,
);
const MAX_RPC_CACHE_TOTAL_BYTES = parseEnvInt(
  process.env.RPC_PROXY_CACHE_MAX_TOTAL_BYTES,
  64 * 1024 * 1024,
  1 * 1024 * 1024,
);
const MAX_RPC_CACHE_ENTRY_BYTES = parseEnvInt(
  process.env.RPC_PROXY_CACHE_MAX_ENTRY_BYTES,
  256 * 1024,
  4 * 1024,
);
const RPC_PROXY_REQUEST_TIMEOUT_MS = parseEnvInt(
  process.env.RPC_PROXY_REQUEST_TIMEOUT_MS,
  15_000,
  1_000,
);
const WS_PROXY_MAX_PENDING_OPEN_MESSAGES = parseEnvInt(
  process.env.WS_PROXY_MAX_PENDING_OPEN_MESSAGES,
  64,
  1,
);
const rpcResponseCache = new Map<string, CachedRpcResponse>();
let rpcResponseCacheTotalBytes = 0;

/** Track inflight requests with timestamps for cleanup */
interface InflightRequest {
  promise: Promise<ProxiedRpcResponse>;
  startedAt: number;
}
const rpcInflightRequests = new Map<string, InflightRequest>();

// Memory leak prevention: cleanup stale inflight requests after 2 minutes
const RPC_INFLIGHT_STALE_MS = 2 * 60 * 1000;
const RPC_INFLIGHT_CLEANUP_INTERVAL_MS = 30 * 1000;

function cleanupStaleInflightRequests(): void {
  const now = Date.now();
  const staleThreshold = now - RPC_INFLIGHT_STALE_MS;

  for (const [key, entry] of rpcInflightRequests) {
    if (entry.startedAt < staleThreshold) {
      rpcInflightRequests.delete(key);
    }
  }
}

// Start periodic cleanup (unref to not keep process alive)
const inflightCleanupTimer = setInterval(
  cleanupStaleInflightRequests,
  RPC_INFLIGHT_CLEANUP_INTERVAL_MS,
);
inflightCleanupTimer.unref?.();

export function resolveSolanaProxyCluster(
  value: unknown,
  fallback: SolanaCluster,
  productionLike: boolean,
): SolanaCluster | null {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "mainnet" || normalized === "mainnet-beta") {
    return "mainnet-beta";
  }
  if (
    normalized === "devnet" ||
    normalized === "testnet" ||
    normalized === "localnet"
  ) {
    return productionLike ? null : normalized;
  }
  return null;
}

export function isCanonicalSolanaAddress(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
  ) {
    return false;
  }
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function resolveRpcUpstream(cluster: SolanaCluster): string {
  if (cluster === "localnet") {
    return process.env.SOLANA_LOCALNET_RPC_URL || "http://127.0.0.1:8899";
  }

  if (cluster === "devnet") {
    return process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  }

  if (cluster === "testnet") {
    return (
      process.env.SOLANA_TESTNET_RPC_URL || "https://api.testnet.solana.com"
    );
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey) {
    return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  }
  return (
    process.env.SOLANA_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"
  );
}

function resolveWsUpstream(cluster: SolanaCluster): string {
  if (cluster === "localnet") {
    return process.env.SOLANA_LOCALNET_WS_URL || "ws://127.0.0.1:8900";
  }

  if (cluster === "devnet") {
    return process.env.SOLANA_DEVNET_WS_URL || "wss://api.devnet.solana.com/";
  }

  if (cluster === "testnet") {
    return process.env.SOLANA_TESTNET_WS_URL || "wss://api.testnet.solana.com/";
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey) {
    return `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  }
  return (
    process.env.SOLANA_MAINNET_WS_URL || "wss://api.mainnet-beta.solana.com"
  );
}

function parseRpcPayload(body: unknown): JsonRpcRequestPayload[] | null {
  if (!body) return null;
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_RPC_BATCH_ENTRIES) return null;
    if (body.some((value) => !value || typeof value !== "object")) return null;
    return body as JsonRpcRequestPayload[];
  }
  if (typeof body === "object") {
    return [body as JsonRpcRequestPayload];
  }
  return null;
}

function isValidRpcPayload(payload: JsonRpcRequestPayload): boolean {
  if (
    payload.jsonrpc !== "2.0" ||
    typeof payload.method !== "string" ||
    payload.method.length < 1 ||
    payload.method.length > MAX_RPC_METHOD_LENGTH ||
    !/^[A-Za-z][A-Za-z0-9]*$/.test(payload.method)
  ) {
    return false;
  }

  if (
    payload.params !== undefined &&
    !Array.isArray(payload.params) &&
    (payload.params === null || typeof payload.params !== "object")
  ) {
    return false;
  }

  return true;
}

function isAllowedWsRpcMessage(message: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  const payloads = parseRpcPayload(parsed);
  return Boolean(
    payloads &&
    payloads.every(
      (payload) =>
        isValidRpcPayload(payload) &&
        WS_PROXY_ALLOWED_METHODS.has(payload.method || ""),
    ),
  );
}

function normalizeRpcIdsForCache(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry, index) => {
      if (!entry || typeof entry !== "object") return entry;
      return {
        ...(entry as Record<string, unknown>),
        id: index,
      };
    });
  }

  if (!body || typeof body !== "object") return body;
  return {
    ...(body as Record<string, unknown>),
    id: 0,
  };
}

function buildRpcCacheKey(
  cluster: SolanaCluster,
  body: unknown,
): string | null {
  try {
    const normalizedBody = normalizeRpcIdsForCache(body);
    return `${cluster}:${JSON.stringify(normalizedBody)}`;
  } catch {
    return null;
  }
}

function rewriteRpcResponseIds(
  responseBody: string,
  requestBody: unknown,
): string {
  try {
    const parsedResponse = JSON.parse(responseBody);

    if (Array.isArray(requestBody)) {
      const requestIds = requestBody.map((entry) =>
        entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).id
          : undefined,
      );

      if (Array.isArray(parsedResponse)) {
        for (let index = 0; index < parsedResponse.length; index += 1) {
          const entry = parsedResponse[index];
          if (!entry || typeof entry !== "object") continue;
          (entry as Record<string, unknown>).id = requestIds[index];
        }
        return JSON.stringify(parsedResponse);
      }

      if (
        parsedResponse &&
        typeof parsedResponse === "object" &&
        requestIds.length > 0
      ) {
        (parsedResponse as Record<string, unknown>).id = requestIds[0];
        return JSON.stringify(parsedResponse);
      }

      return responseBody;
    }

    if (
      parsedResponse &&
      typeof parsedResponse === "object" &&
      requestBody &&
      typeof requestBody === "object"
    ) {
      (parsedResponse as Record<string, unknown>).id = (
        requestBody as Record<string, unknown>
      ).id;
      return JSON.stringify(parsedResponse);
    }

    return responseBody;
  } catch {
    return responseBody;
  }
}

function canCacheRpcPayload(payloads: JsonRpcRequestPayload[] | null): boolean {
  if (!payloads || payloads.length === 0) return false;
  return payloads.every((payload) => {
    const method = payload.method;
    return typeof method === "string" && RPC_CACHEABLE_METHODS.has(method);
  });
}

function getRpcCacheTtlMs(payloads: JsonRpcRequestPayload[]): number {
  let minTtl = Number.POSITIVE_INFINITY;
  for (const payload of payloads) {
    const method = payload.method;
    if (typeof method !== "string") continue;
    const ttl = RPC_CACHE_TTL_MS_BY_METHOD[method] ?? DEFAULT_RPC_CACHE_TTL_MS;
    if (ttl < minTtl) minTtl = ttl;
  }
  if (!Number.isFinite(minTtl)) return DEFAULT_RPC_CACHE_TTL_MS;
  return Math.max(100, minTtl);
}

function getCachedRpcResponse(cacheKey: string): CachedRpcResponse | null {
  const cached = rpcResponseCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    deleteCachedRpcResponse(cacheKey, cached);
    return null;
  }
  return cached;
}

function deleteCachedRpcResponse(
  cacheKey: string,
  cachedValue?: CachedRpcResponse,
): void {
  const cached = cachedValue ?? rpcResponseCache.get(cacheKey);
  if (!cached) return;
  rpcResponseCache.delete(cacheKey);
  rpcResponseCacheTotalBytes = Math.max(
    0,
    rpcResponseCacheTotalBytes - Math.max(0, cached.byteSize || 0),
  );
}

function pruneExpiredRpcCacheEntries(nowMs: number): void {
  for (const [cacheKey, cached] of rpcResponseCache.entries()) {
    if (cached.expiresAt > nowMs) continue;
    deleteCachedRpcResponse(cacheKey, cached);
  }
}

function setCachedRpcResponse(
  cacheKey: string,
  value: CachedRpcResponse,
): void {
  const existing = rpcResponseCache.get(cacheKey);
  if (existing) {
    rpcResponseCacheTotalBytes = Math.max(
      0,
      rpcResponseCacheTotalBytes - Math.max(0, existing.byteSize || 0),
    );
  }
  rpcResponseCache.set(cacheKey, value);
  rpcResponseCacheTotalBytes += Math.max(0, value.byteSize || 0);
}

function pruneRpcCache(nowMs: number = Date.now()): void {
  pruneExpiredRpcCacheEntries(nowMs);

  while (
    rpcResponseCache.size > MAX_RPC_CACHE_ENTRIES ||
    rpcResponseCacheTotalBytes > MAX_RPC_CACHE_TOTAL_BYTES
  ) {
    const oldest = rpcResponseCache.entries().next().value as
      [string, CachedRpcResponse] | undefined;
    if (!oldest) break;
    deleteCachedRpcResponse(oldest[0], oldest[1]);
  }
}

async function proxySolanaRpcRequest(
  fastify: FastifyInstance,
  request: FastifyRequest<{ Querystring: { cluster?: string } }>,
  reply: FastifyReply,
  defaultCluster: SolanaCluster,
  productionLike: boolean,
): Promise<void> {
  const cluster = resolveSolanaProxyCluster(
    request.query?.cluster,
    defaultCluster,
    productionLike,
  );
  if (!cluster) {
    reply.status(400).send({ error: "Unsupported Solana cluster" });
    return;
  }
  const upstreamUrl = resolveRpcUpstream(cluster);

  let requestBody = request.body;
  if (typeof requestBody === "string") {
    try {
      requestBody = JSON.parse(requestBody);
    } catch {
      requestBody = null;
    }
  }

  if (!requestBody || typeof requestBody !== "object") {
    reply.status(400).send({ error: "Invalid JSON-RPC payload" });
    return;
  }

  let requestBodyText = "";
  try {
    requestBodyText = JSON.stringify(requestBody);
  } catch {
    reply.status(400).send({ error: "Invalid JSON-RPC payload" });
    return;
  }

  const payloads = parseRpcPayload(requestBody);
  if (
    Buffer.byteLength(requestBodyText, "utf8") > MAX_RPC_REQUEST_BYTES ||
    !payloads ||
    !payloads.every(isValidRpcPayload)
  ) {
    reply.status(400).send({ error: "Invalid JSON-RPC payload" });
    return;
  }
  const shouldCache = canCacheRpcPayload(payloads);
  const cacheTtlMs = shouldCache ? getRpcCacheTtlMs(payloads || []) : 0;
  const cacheKey = shouldCache ? buildRpcCacheKey(cluster, requestBody) : null;

  if (cacheKey) {
    const cached = getCachedRpcResponse(cacheKey);
    if (cached) {
      const adjustedBody = rewriteRpcResponseIds(cached.body, requestBody);
      reply.header("Content-Type", cached.contentType);
      reply.header("x-rpc-cache", "hit");
      reply.status(cached.status).send(adjustedBody);
      return;
    }
  }

  if (cacheKey) {
    const inflight = rpcInflightRequests.get(cacheKey);
    if (inflight) {
      const shared = await inflight.promise;
      const adjustedBody = rewriteRpcResponseIds(shared.body, requestBody);
      reply.header("Content-Type", shared.contentType);
      reply.header("x-rpc-cache", "coalesced");
      reply.status(shared.status).send(adjustedBody);
      return;
    }
  }

  const executeProxy = async (): Promise<ProxiedRpcResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, RPC_PROXY_REQUEST_TIMEOUT_MS);

    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: requestBodyText,
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeout);
    });

    const body = await response.text();
    const contentType =
      response.headers.get("content-type") || "application/json";

    const result: ProxiedRpcResponse = {
      status: response.status,
      body,
      contentType,
    };

    if (cacheKey && response.ok && cacheTtlMs > 0) {
      const byteSize = Buffer.byteLength(body, "utf8");
      if (byteSize <= MAX_RPC_CACHE_ENTRY_BYTES) {
        setCachedRpcResponse(cacheKey, {
          ...result,
          expiresAt: Date.now() + cacheTtlMs,
          byteSize,
        });
        pruneRpcCache();
      }
    }

    return result;
  };

  const proxyPromise = executeProxy();
  if (cacheKey) {
    rpcInflightRequests.set(cacheKey, {
      promise: proxyPromise,
      startedAt: Date.now(),
    });
  }

  try {
    const proxied = await proxyPromise;
    reply.header("Content-Type", proxied.contentType);
    if (cacheKey) {
      reply.header("x-rpc-cache", "miss");
    }
    reply.status(proxied.status).send(proxied.body);
  } catch (error: unknown) {
    fastify.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Solana RPC proxy request failed",
    );
    if (error instanceof Error && error.name === "AbortError") {
      reply.status(504).send({ error: "Solana RPC upstream timeout" });
      return;
    }
    reply.status(500).send({ error: "Failed to proxy Solana RPC request" });
  } finally {
    if (cacheKey) {
      rpcInflightRequests.delete(cacheKey);
    }
  }
}

function registerSolanaWsProxyRoute(
  fastify: FastifyInstance,
  routePath: string,
  defaultCluster: SolanaCluster,
  productionLike: boolean,
  requireBrowserOrigin: ReturnType<
    typeof createRequiredBrowserOriginPreHandler
  >,
): void {
  const validateCluster = async (
    request: FastifyRequest<{ Querystring: { cluster?: string } }>,
    reply: FastifyReply,
  ) => {
    if (
      !resolveSolanaProxyCluster(
        request.query?.cluster,
        defaultCluster,
        productionLike,
      )
    ) {
      return reply.status(400).send({ error: "Unsupported Solana cluster" });
    }
  };
  fastify.get<{ Querystring: { cluster?: string } }>(
    routePath,
    {
      websocket: true,
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      preValidation: productionLike
        ? [requireBrowserOrigin, validateCluster]
        : [validateCluster],
    },
    (connection, req) => {
      const cluster = resolveSolanaProxyCluster(
        req.query?.cluster,
        defaultCluster,
        productionLike,
      );
      if (!cluster) {
        connection.close();
        return;
      }
      const upstreamWsUrl = resolveWsUpstream(cluster);

      import("ws")
        .then(({ default: WebSocket }) => {
          const upstreamSocket = new WebSocket(upstreamWsUrl, {
            maxPayload: 2 * 1024 * 1024,
          });
          // Fastify WebSocket connection wraps the socket - access it safely
          // The connection from @fastify/websocket is a ws WebSocket
          const wsClient = ((connection as unknown as { socket?: WsWebSocket })
            .socket || connection) as WsWebSocket;
          const pendingOpenMessages: string[] = [];
          let bridgeClosed = false;
          let messageWindowStartedAt = Date.now();
          let messageCount = 0;

          const closeBridge = (): void => {
            if (bridgeClosed) return;
            bridgeClosed = true;
            pendingOpenMessages.length = 0;
            try {
              wsClient.removeAllListeners?.("message");
              wsClient.removeAllListeners?.("close");
              wsClient.removeAllListeners?.("error");
            } catch {}
            try {
              upstreamSocket.removeAllListeners("open");
              upstreamSocket.removeAllListeners("message");
              upstreamSocket.removeAllListeners("close");
              upstreamSocket.removeAllListeners("error");
            } catch {}
          };

          const flushPendingMessages = (): void => {
            if (
              bridgeClosed ||
              upstreamSocket.readyState !== WebSocket.OPEN ||
              pendingOpenMessages.length === 0
            ) {
              return;
            }
            for (const pending of pendingOpenMessages) {
              upstreamSocket.send(pending);
            }
            pendingOpenMessages.length = 0;
          };

          wsClient.on("message", (message: Buffer | string) => {
            if (bridgeClosed) return;
            const messageByteLength = Buffer.isBuffer(message)
              ? message.byteLength
              : Buffer.byteLength(message, "utf8");
            if (messageByteLength > MAX_WS_PROXY_MESSAGE_BYTES) {
              closeBridge();
              upstreamSocket.close();
              wsClient.close(1009, "Message too large");
              return;
            }

            const now = Date.now();
            if (now - messageWindowStartedAt >= 60_000) {
              messageWindowStartedAt = now;
              messageCount = 0;
            }
            messageCount += 1;
            if (messageCount > MAX_WS_PROXY_MESSAGES_PER_MINUTE) {
              closeBridge();
              upstreamSocket.close();
              wsClient.close(1008, "Message rate exceeded");
              return;
            }

            const normalized = message.toString();
            if (!isAllowedWsRpcMessage(normalized)) {
              closeBridge();
              upstreamSocket.close();
              wsClient.close(1008, "Unsupported JSON-RPC message");
              return;
            }
            if (upstreamSocket.readyState === WebSocket.OPEN) {
              upstreamSocket.send(normalized);
              return;
            }
            pendingOpenMessages.push(normalized);
            if (
              pendingOpenMessages.length > WS_PROXY_MAX_PENDING_OPEN_MESSAGES
            ) {
              pendingOpenMessages.shift();
            }
          });

          upstreamSocket.once("open", flushPendingMessages);

          upstreamSocket.on("message", (data: Buffer | string) => {
            if (bridgeClosed) return;
            // WebSocket.OPEN === 1
            if (wsClient.readyState === 1) {
              wsClient.send(data);
            }
          });

          wsClient.on("close", () => {
            closeBridge();
            upstreamSocket.close();
          });

          wsClient.on("error", () => {
            closeBridge();
            upstreamSocket.close();
          });

          upstreamSocket.on("close", () => {
            closeBridge();
            wsClient.close();
          });

          upstreamSocket.on("error", (err: Error) => {
            fastify.log.error(
              { errorName: err.name },
              "Solana WS proxy upstream failed",
            );
            closeBridge();
            wsClient.close();
          });
        })
        .catch(() => {
          fastify.log.error("Failed to load Solana WS proxy dependency");
          // Fastify WebSocket connection wraps the socket - access it safely
          // The connection from @fastify/websocket is a ws WebSocket
          const wsClient = ((connection as unknown as { socket?: WsWebSocket })
            .socket || connection) as WsWebSocket;
          wsClient.close();
        });
    },
  );
}

export function registerProxyRoutes(
  fastify: FastifyInstance,
  config: Pick<ServerConfig, "nodeEnv">,
): void {
  const productionLike = isProductionLikeEnvironment(config.nodeEnv);
  const requireBrowserOrigin = createRequiredBrowserOriginPreHandler(
    resolveAllowedOrigins(config.nodeEnv),
  );
  const browserOnlyRouteOptions = {
    bodyLimit: MAX_RPC_REQUEST_BYTES,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    ...(productionLike ? { preHandler: requireBrowserOrigin } : {}),
  };
  const rpcRouteOptions = {
    bodyLimit: MAX_RPC_REQUEST_BYTES,
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    ...(productionLike ? { preHandler: requireBrowserOrigin } : {}),
  };

  // Proxy for Birdeye API
  fastify.get<{ Querystring: { address: string } }>(
    "/api/proxy/birdeye/price",
    browserOnlyRouteOptions,
    async (
      request: FastifyRequest<{ Querystring: { address: string } }>,
      reply: FastifyReply,
    ) => {
      const apiKey = process.env.BIRDEYE_API_KEY;
      if (!apiKey) {
        return reply.status(503).send({ error: "Price service unavailable" });
      }

      const { address } = request.query;
      if (!isCanonicalSolanaAddress(address)) {
        return reply.status(400).send({ error: "Invalid address parameter" });
      }

      try {
        const response = await fetch(
          `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(address)}`,
          {
            headers: {
              "X-API-KEY": apiKey,
              "x-chain": "solana",
            },
          },
        );

        if (!response.ok) {
          throw new Error(`Birdeye API error: ${response.statusText}`);
        }

        const data = await response.json();
        return reply.send(data);
      } catch (error: unknown) {
        fastify.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Birdeye price proxy request failed",
        );
        return reply
          .status(500)
          .send({ error: "Failed to fetch from Birdeye" });
      }
    },
  );

  // Cluster-aware Solana RPC proxy.
  fastify.post<{ Querystring: { cluster?: string } }>(
    "/api/proxy/solana/rpc",
    rpcRouteOptions,
    async (request, reply) =>
      proxySolanaRpcRequest(
        fastify,
        request,
        reply,
        "mainnet-beta",
        productionLike,
      ),
  );

  // Backwards-compatible alias used by existing frontends.
  fastify.post<{ Querystring: { cluster?: string } }>(
    "/api/proxy/helius/rpc",
    rpcRouteOptions,
    async (request, reply) =>
      proxySolanaRpcRequest(
        fastify,
        request,
        reply,
        "mainnet-beta",
        productionLike,
      ),
  );

  // Cluster-aware Solana WS proxy and Helius-compatible alias.
  registerSolanaWsProxyRoute(
    fastify,
    "/api/proxy/solana/ws",
    "mainnet-beta",
    productionLike,
    requireBrowserOrigin,
  );
  registerSolanaWsProxyRoute(
    fastify,
    "/api/proxy/helius/ws",
    "mainnet-beta",
    productionLike,
    requireBrowserOrigin,
  );
}
