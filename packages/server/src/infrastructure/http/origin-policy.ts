import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type AllowedOrigin = string | RegExp;

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const MAX_ORIGIN_BYTES = 2048;

const PRODUCTION_ORIGINS = [
  "https://hyperbet.win",
  "https://www.hyperbet.win",
  "https://api.hyperbet.win",
  "https://hyperia.gg",
  "https://www.hyperia.gg",
  "https://hyperia.club",
  "https://www.hyperia.club",
  "https://hyperia.pages.dev",
  "https://hyperia-betting.pages.dev",
  "https://hyperbet.pages.dev",
  "https://hyperbet-solana.pages.dev",
  "https://hyperia-production.up.railway.app",
] as const;

const OWNED_PREVIEW_ORIGINS = [
  /^https:\/\/(?:[a-z0-9-]+\.)+hyperia-betting\.pages\.dev$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)+hyperbet\.pages\.dev$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)+hyperbet-solana\.pages\.dev$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)+hyperia\.pages\.dev$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*hyperia\.gg$/i,
] as const;

const TRUSTED_EMBED_ORIGINS = [
  /^https:\/\/(?:[a-z0-9-]+\.)+farcaster\.xyz$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)+warpcast\.com$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)+privy\.io$/i,
] as const;

const DEVELOPMENT_ORIGINS = [
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i,
  /^https?:\/\/\[::1\](?::\d{1,5})?$/i,
  /^https?:\/\/10(?:\.\d{1,3}){3}(?::\d{1,5})?$/,
  /^https?:\/\/192\.168(?:\.\d{1,3}){2}(?::\d{1,5})?$/,
  /^https?:\/\/172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}(?::\d{1,5})?$/,
] as const;

export function isProductionLikeEnvironment(nodeEnv: string): boolean {
  return nodeEnv === "production" || nodeEnv === "staging";
}

function normalizeConfiguredBrowserOrigin(
  name: "CLIENT_URL" | "PUBLIC_APP_URL" | "DUEL_LOCAL_BROWSER_ORIGIN",
  value: string | undefined,
  productionLike: boolean,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.trim() !== value) {
    throw new Error(`${name} must not contain outer whitespace`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} must contain only an HTTP(S) origin`);
  }
  if (productionLike && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production or staging`);
  }

  return parsed.origin;
}

function resolveLocalSmokeBrowserOrigin(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = env.DUEL_LOCAL_BROWSER_ORIGIN;
  if (value === undefined || value === "") return undefined;

  if (env.DUEL_LOCAL_SMOKE_MODE !== "true" || env.LOAD_TEST_MODE !== "true") {
    throw new Error(
      "DUEL_LOCAL_BROWSER_ORIGIN requires the exact local-smoke and load-test boundary",
    );
  }

  const origin = normalizeConfiguredBrowserOrigin(
    "DUEL_LOCAL_BROWSER_ORIGIN",
    value,
    false,
  );
  if (!origin) return undefined;

  const parsed = new URL(origin);
  const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    parsed.protocol !== "http:" ||
    !loopbackHostnames.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error(
      "DUEL_LOCAL_BROWSER_ORIGIN must use HTTP on an exact loopback hostname",
    );
  }

  return origin;
}

export function resolveAllowedOrigins(
  nodeEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): AllowedOrigin[] {
  const productionLike = isProductionLikeEnvironment(nodeEnv);
  const origins: AllowedOrigin[] = [
    ...PRODUCTION_ORIGINS,
    ...OWNED_PREVIEW_ORIGINS,
    ...TRUSTED_EMBED_ORIGINS,
  ];

  for (const [name, value] of [
    ["PUBLIC_APP_URL", env.PUBLIC_APP_URL],
    ["CLIENT_URL", env.CLIENT_URL],
  ] as const) {
    const configured = normalizeConfiguredBrowserOrigin(
      name,
      value,
      productionLike,
    );
    if (configured && !origins.includes(configured)) origins.push(configured);
  }

  const localSmokeBrowserOrigin = resolveLocalSmokeBrowserOrigin(env);
  if (localSmokeBrowserOrigin && !origins.includes(localSmokeBrowserOrigin)) {
    origins.push(localSmokeBrowserOrigin);
  }

  if (!productionLike) origins.push(...DEVELOPMENT_ORIGINS);
  return origins;
}

export function createOriginValidator(allowedOrigins: AllowedOrigin[]) {
  return function validateOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    if (Buffer.byteLength(origin, "utf8") > MAX_ORIGIN_BYTES) return false;

    return allowedOrigins.some((allowed) =>
      typeof allowed === "string" ? origin === allowed : allowed.test(origin),
    );
  };
}

function readSingleOrigin(request: FastifyRequest): string | undefined {
  let occurrences = 0;
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "origin") occurrences += 1;
  }
  if (occurrences > 1) return undefined;

  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.includes(",")) return undefined;
  return origin;
}

export function createRequiredBrowserOriginPreHandler(
  allowedOrigins: AllowedOrigin[],
) {
  const isValidOrigin = createOriginValidator(allowedOrigins);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = readSingleOrigin(request);
    if (!origin || !isValidOrigin(origin)) {
      return reply
        .code(403)
        .header("Cache-Control", "no-store")
        .send({ error: "Forbidden" });
    }
  };
}

export function registerWriteOriginProtection(
  fastify: FastifyInstance,
  allowedOrigins: AllowedOrigin[],
): void {
  const isValidOrigin = createOriginValidator(allowedOrigins);
  fastify.addHook("preHandler", async (request, reply) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;

    const headerValue = request.headers.origin;
    if (headerValue === undefined) return;

    const origin = readSingleOrigin(request);
    if (!origin || !isValidOrigin(origin)) {
      return reply
        .code(403)
        .header("Cache-Control", "no-store")
        .send({ error: "Forbidden" });
    }
  });
}
