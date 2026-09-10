/**
 * HTTP Server Module - Fastify setup and static file serving
 *
 * Configures and initializes the Fastify HTTP server with all necessary
 * middleware, static file serving, CORS, WebSocket support, and proper
 * caching headers for production performance.
 *
 * Responsibilities:
 * - Create Fastify instance with logging
 * - Configure CORS for development and production
 * - Set up static file serving (public/, assets/, world/)
 * - Configure proper MIME types and caching headers
 * - Handle index.html for SPA routing
 * - Register multipart and WebSocket plugins
 * - Set up error handlers
 *
 * Usage:
 * ```typescript
 * const fastify = await createHttpServer(config);
 * // Register routes...
 * await fastify.listen({ port: config.port, host: '0.0.0.0' });
 * ```
 */

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import statics from "@fastify/static";
import fastifyWebSocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import fs from "fs-extra";
import path from "path";
import type { ServerConfig } from "./config.js";
import {
  getGlobalRateLimit,
  isRateLimitEnabled,
} from "../infrastructure/rate-limit/rate-limit-config.js";
import { resolveTrustedProxy } from "../infrastructure/rate-limit/trusted-proxy.js";
import { registerCloudflareOriginLock } from "../infrastructure/cloudflare/origin-lock.js";
import {
  registerCsrfProtection,
  enforceSameSiteCookies,
} from "../middleware/csrf.js";
import {
  isProductionLikeEnvironment,
  registerWriteOriginProtection,
  resolveAllowedOrigins,
} from "../infrastructure/http/origin-policy.js";
import { shouldServeSpaForRequestUrl } from "../infrastructure/http/request-path-policy.js";

type PublicRootInfo = {
  root: string;
  indexPath: string;
  assetsPath: string;
  source: "server-public" | "client-dist";
};

async function resolvePublicRoot(
  config: ServerConfig,
): Promise<PublicRootInfo> {
  const serverPublicRoot = path.join(config.__dirname, "public");
  const serverIndexPath = path.join(serverPublicRoot, "index.html");
  const serverAssetsPath = path.join(serverPublicRoot, "assets");

  const clientDistRoot = path.resolve(config.__dirname, "..", "client", "dist");
  const clientDistIndex = path.join(clientDistRoot, "index.html");
  const clientDistAssets = path.join(clientDistRoot, "assets");

  if (await fs.pathExists(serverAssetsPath)) {
    return {
      root: serverPublicRoot,
      indexPath: serverIndexPath,
      assetsPath: serverAssetsPath,
      source: "server-public",
    };
  }

  if (await fs.pathExists(clientDistIndex)) {
    return {
      root: clientDistRoot,
      indexPath: clientDistIndex,
      assetsPath: clientDistAssets,
      source: "client-dist",
    };
  }

  return {
    root: serverPublicRoot,
    indexPath: serverIndexPath,
    assetsPath: serverAssetsPath,
    source: "server-public",
  };
}

/**
 * Create and configure Fastify HTTP server
 *
 * Sets up Fastify with all middleware, static file serving, CORS, WebSocket
 * support, and proper caching headers. Does NOT start the server listening -
 * that's done after routes are registered.
 *
 * @param config - Server configuration
 * @returns Promise resolving to configured Fastify instance
 */
export async function createHttpServer(
  config: ServerConfig,
): Promise<FastifyInstance> {
  console.log("[HTTP] Creating Fastify server...");

  const trustProxy = resolveTrustedProxy(process.env);

  // Create Fastify instance with minimal logging
  const fastify = Fastify({
    logger: { level: "error" },
    trustProxy,
  });
  console.log(`[HTTP] ✅ trustProxy=${JSON.stringify(trustProxy)}`);

  const allowedOrigins = resolveAllowedOrigins(config.nodeEnv);

  await fastify.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "PUT", "POST", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-CSRF-Token", // Allow CSRF token header
      "solana-client", // Required by @solana/web3.js browser RPC requests
      "x-admin-code", // Admin panel authentication
    ],
  });
  console.log(
    "[HTTP] ✅ CORS configured for:",
    allowedOrigins.slice(0, 4).join(", "),
    "...",
  );

  // Defense in depth for browser-originated writes. Server-to-server requests
  // legitimately omit Origin and continue to authenticate at their route boundary.
  registerWriteOriginProtection(fastify, allowedOrigins);
  console.log(
    "[HTTP] ✅ Origin validation enabled for state-changing requests",
  );

  // Optional origin lock for Cloudflare-proxied deployments.
  // When set, only requests carrying the shared origin secret header are accepted
  // (except health/status endpoints used by platform checks).
  const originLock = registerCloudflareOriginLock(fastify);
  if (originLock.enabled) {
    console.log(
      `[HTTP] ✅ Cloudflare origin secret enforcement enabled (fingerprint=${originLock.fingerprint})`,
    );
  } else {
    console.log("[HTTP] ℹ️  Cloudflare origin secret enforcement disabled");
  }

  // Configure rate limiting for production security
  if (isRateLimitEnabled()) {
    await fastify.register(rateLimit, getGlobalRateLimit());
    console.log(
      "[HTTP] ✅ Rate limiting enabled (100 requests/min per IP globally)",
    );
  } else {
    console.log("[HTTP] ⚠️  Rate limiting disabled (development mode)");
  }

  // Configure CSRF protection for state-changing requests
  // This provides defense-in-depth even though we use token-based auth
  if (
    process.env.NODE_ENV === "production" ||
    process.env.CSRF_ENABLED === "true"
  ) {
    registerCsrfProtection(fastify);
    enforceSameSiteCookies(fastify);
    console.log("[HTTP] ✅ CSRF protection enabled");
  } else {
    console.log("[HTTP] ⚠️  CSRF protection disabled (development mode)");
    // Still expose GET /api/csrf-token so the dashboard API client does not 404.
    // CSRF validation is skipped when Authorization: Bearer is present (see middleware/csrf.ts).
    fastify.get("/api/csrf-token", async (_request, reply) => {
      return reply.send({
        token: "dev-csrf-disabled",
        csrfToken: "dev-csrf-disabled",
      });
    });
    console.log(
      "[HTTP] ✅ Dev CSRF token stub registered (validation still off unless CSRF_ENABLED=true)",
    );
  }

  // Serve index.html for root path (SPA routing)
  await registerIndexHtmlRoute(fastify, config);

  // Register static file serving (public/, assets/)
  await registerStaticFiles(fastify, config);

  // Register multipart for file uploads
  fastify.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
    },
  });
  console.log("[HTTP] ✅ Multipart registered");

  // Register WebSocket support
  fastify.register(fastifyWebSocket);
  console.log("[HTTP] ✅ WebSocket support registered");

  // Set up error handler
  fastify.setErrorHandler((err, _req, reply) => {
    fastify.log.error(err);
    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;

    if (statusCode >= 400 && statusCode < 500) {
      const error =
        statusCode === 401
          ? "Unauthorized"
          : statusCode === 403
            ? "Forbidden"
            : statusCode === 404
              ? "Not found"
              : "Request error";
      reply.status(statusCode).send({ error });
      return;
    }

    reply.status(500).send({ error: "Internal server error" });
  });

  if (!isProductionLikeEnvironment(config.nodeEnv)) {
    // Local diagnostics only: this intentionally exposes filesystem layout.
    fastify.get("/debug/public", async (_req, reply) => {
      const publicDir = path.join(config.__dirname, "public");
      const assetsDir = path.join(publicDir, "assets");
      const publicContents = await fs.readdir(publicDir).catch(() => []);
      const assetsContents = await fs.readdir(assetsDir).catch(() => []);
      return reply.send({
        publicDir,
        assetsDir,
        publicContents,
        assetsContents: assetsContents.slice(0, 20),
        configDirname: config.__dirname,
      });
    });
  }

  // SPA catch-all route - serve index.html for any unmatched routes
  // This must be registered AFTER all other routes
  await registerSpaCatchAll(fastify, config);

  console.log("[HTTP] ✅ HTTP server created");
  return fastify;
}

/**
 * Register index.html routes for SPA
 *
 * Serves index.html for both "/" and "/index.html" with no-cache headers
 * to ensure clients always get the latest version.
 *
 * @param fastify - Fastify instance
 * @param config - Server configuration
 * @private
 */
async function registerIndexHtmlRoute(
  fastify: FastifyInstance,
  config: ServerConfig,
): Promise<void> {
  const publicInfo = await resolvePublicRoot(config);
  const indexHtmlPath = publicInfo.indexPath;

  // Check if index.html exists before registering routes
  if (!(await fs.pathExists(indexHtmlPath))) {
    // Get additional debug info
    const publicDir = path.dirname(indexHtmlPath);
    let publicDirContents: string[] = [];
    try {
      publicDirContents = await fs.readdir(publicDir);
    } catch {
      publicDirContents = ["ERROR: Could not read directory"];
    }

    console.log(
      `[HTTP] ⚠️  No index.html found at ${indexHtmlPath}, registering fallback routes`,
    );
    console.log(
      `[HTTP] ⚠️  Public dir contents: ${JSON.stringify(publicDirContents)}`,
    );
    console.log(`[HTTP] ⚠️  Public source: ${publicInfo.source}`);
    console.log(`[HTTP] ⚠️  config.__dirname: ${config.__dirname}`);
    console.log(`[HTTP] ⚠️  process.cwd(): ${process.cwd()}`);

    // Keep operator detail in server logs; never disclose absolute paths or
    // directory contents to an unauthenticated caller.
    const fallbackHandler = async (
      _req: FastifyRequest,
      reply: FastifyReply,
    ) => {
      return reply.status(503).send({
        error: "Frontend not available",
        message:
          "The client application has not been built or deployed. Please ensure the client is built and copied to the server's public directory.",
      });
    };

    fastify.get("/", fallbackHandler);
    fastify.get("/index.html", fallbackHandler);
    console.log("[HTTP] ⚠️  Fallback routes registered (frontend not found)");
    return;
  }

  console.log(
    `[HTTP] ✅ Serving client from ${publicInfo.source}: ${publicInfo.root}`,
  );
  const serveIndexHtml = async (_req: FastifyRequest, reply: FastifyReply) => {
    const html = await fs.promises.readFile(indexHtmlPath, "utf-8");

    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-cache, no-store, must-revalidate")
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .send(html);
  };

  fastify.get("/", serveIndexHtml);
  fastify.get("/index.html", serveIndexHtml);
  console.log("[HTTP] ✅ Index.html routes registered");
}

/**
 * Register all static file serving
 *
 * Sets up static file serving for:
 * - Public directory (client app, scripts, CSS)
 * - World assets (/assets/world/)
 * - Legacy assets route (/assets/)
 * - Manual music route (workaround for static issues)
 * - System plugins (if SYSTEMS_PATH is set)
 *
 * @param fastify - Fastify instance
 * @param config - Server configuration
 * @private
 */
async function registerStaticFiles(
  fastify: FastifyInstance,
  config: ServerConfig,
): Promise<void> {
  const publicInfo = await resolvePublicRoot(config);
  // Serve public directory with proper caching
  await fastify.register(statics, {
    root: publicInfo.root,
    prefix: "/",
    decorateReply: false,
    list: false,
    index: false,
    setHeaders: (res, filePath) => {
      setStaticHeaders(res, filePath);
    },
  });
  console.log(`[HTTP] ✅ Public directory registered (${publicInfo.source})`);

  // HLS segments are generated runtime data. Integrated launchers place them
  // outside the source tree to avoid filesystem-sync and indexing contention;
  // standalone deployments retain the historical server/public/live default.
  const configuredHlsDir = process.env.HLS_PUBLIC_DIR?.trim();
  const hlsDir = configuredHlsDir
    ? path.isAbsolute(configuredHlsDir)
      ? configuredHlsDir
      : path.resolve(config.__dirname, configuredHlsDir)
    : path.join(config.__dirname, "public", "live");
  await fs.ensureDir(hlsDir);
  await fastify.register(statics, {
    root: hlsDir,
    prefix: "/live/",
    decorateReply: false,
    setHeaders: (res, filePath) => {
      setHlsStaticHeaders(res, filePath);
    },
  });
  console.log(`[HTTP] ✅ Registered /live/ → ${hlsDir}`);

  // Check if client assets exist in public/assets (built frontend)
  // If they do, we DON'T want to register /assets/ for world assets as it would conflict
  const hasClientAssets = await fs.pathExists(publicInfo.assetsPath);

  if (hasClientAssets) {
    console.log(
      `[HTTP] ✅ Client assets found in ${publicInfo.assetsPath} - serving from there`,
    );
  }

  // Always serve manifests from the dedicated cache directory for compatibility.
  // This guarantees /game-assets/manifests/* works even when game-assets root points
  // at a directory that doesn't contain the full manifest set.
  console.error(
    `[HTTP DEBUG] Registering /game-assets/manifests/ with root: ${config.manifestsDir}`,
  );
  await fastify.register(statics, {
    root: config.manifestsDir,
    prefix: "/game-assets/manifests/",
    decorateReply: false,
    setHeaders: (res, filePath) => {
      setManifestHeaders(res, filePath);
    },
  });
  console.log(
    `[HTTP] ✅ Registered /game-assets/manifests/ → ${config.manifestsDir}`,
  );

  // Register world assets for local/streaming clients.
  // Prefer world/assets when present (authoritative source in this repo),
  // then fall back to cached assetsDir.
  const worldAssetsDir = path.join(config.worldDir, "assets");
  const hasWorldAssetsDir = await fs.pathExists(worldAssetsDir);
  const hasCachedAssetsDir = await fs.pathExists(config.assetsDir);
  const gameAssetsRoot = hasWorldAssetsDir
    ? worldAssetsDir
    : hasCachedAssetsDir
      ? config.assetsDir
      : null;

  if (gameAssetsRoot) {
    await fastify.register(statics, {
      root: gameAssetsRoot,
      prefix: "/game-assets/",
      decorateReply: false,
      setHeaders: (res, filePath) => {
        setAssetHeaders(res, filePath);
      },
    });
    console.log(`[HTTP] ✅ Registered /game-assets/ → ${gameAssetsRoot}`);

    const legacyAssetsRoot = hasCachedAssetsDir
      ? config.assetsDir
      : gameAssetsRoot;
    await fastify.register(statics, {
      root: legacyAssetsRoot,
      prefix: "/assets/world/",
      decorateReply: false,
      setHeaders: (res, filePath) => {
        setAssetHeaders(res, filePath);
      },
    });
    console.log(`[HTTP] ✅ Registered /assets/world/ → ${legacyAssetsRoot}`);

    // Manual music route (workaround for static file issues)
    registerMusicRoute(fastify, config);

    // ONLY register /assets/ for world assets if NO client assets exist
    // Otherwise, the public directory already serves /assets/ for the frontend
    if (!hasClientAssets) {
      await fastify.register(statics, {
        root: legacyAssetsRoot,
        prefix: "/assets/",
        decorateReply: false,
        setHeaders: (res, filePath) => {
          setAssetHeaders(res, filePath);
        },
      });
      console.log(`[HTTP] ✅ Registered /assets/ → ${legacyAssetsRoot}`);
    }
  } else {
    console.log(
      `[HTTP] ⏭️  Skipping local assets routes (assets served from CDN: ${config.cdnUrl})`,
    );
  }

  // Register manifests at /manifests/ for DataManager compatibility
  // Manifests are fetched from CDN at startup and cached in manifestsDir
  await fastify.register(statics, {
    root: config.manifestsDir,
    prefix: "/manifests/",
    decorateReply: false,
    setHeaders: (res, filePath) => {
      // Manifests should have short cache to allow updates
      // But not no-cache (that would cause excessive requests)
      setManifestHeaders(res, filePath);
    },
  });
  console.log(`[HTTP] ✅ Registered /manifests/ → ${config.manifestsDir}`);

  // Register icons directory for item sprite PNGs
  if (await fs.pathExists(config.iconsDir)) {
    await fastify.register(statics, {
      root: config.iconsDir,
      prefix: "/icons/",
      decorateReply: false,
      setHeaders: (res, filePath) => {
        setAssetHeaders(res, filePath);
      },
    });
    console.log(`[HTTP] ✅ Registered /icons/ → ${config.iconsDir}`);
  }

  // Log available assets
  await logAvailableAssets(fastify, config);

  // Register systems static serving if available
  if (config.systemsPath) {
    await fastify.register(statics, {
      root: config.systemsPath,
      prefix: "/dist/",
      decorateReply: false,
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET");
      },
    });
    console.log(`[HTTP] ✅ Registered /dist/ → ${config.systemsPath}`);
  }
}

/**
 * Set headers for public static files
 *
 * Configures caching and MIME types for scripts, CSS, HTML, and WASM files.
 *
 * @param res - HTTP response object
 * @param filePath - Path to the file being served
 * @private
 */
export function setHlsStaticHeaders(
  res: { setHeader: (k: string, v: string) => void },
  filePath: string,
): void {
  if (filePath.endsWith(".m3u8")) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (filePath.endsWith(".ts")) {
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Cache-Control", "public, max-age=60");
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Timing-Allow-Origin", "*");
}

export function setStaticHeaders(
  res: { setHeader: (k: string, v: string) => void },
  filePath: string,
): void {
  // HLS streaming files (must be checked before .ts to avoid TypeScript conflict)
  if (filePath.endsWith(".m3u8")) {
    setHlsStaticHeaders(res, filePath);
    return;
  } else if (filePath.includes("/live/") && filePath.endsWith(".ts")) {
    setHlsStaticHeaders(res, filePath);
    return;
  } else if (filePath.endsWith(".wasm")) {
    res.setHeader("Content-Type", "application/wasm");
    res.setHeader("Cache-Control", "public, max-age=3600");
  } else if (filePath.endsWith(".js")) {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    if (filePath.includes("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300");
    }
  } else if (filePath.endsWith(".css")) {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    if (filePath.includes("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300");
    }
  } else if (filePath.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300");
  }

  // Security headers for SharedArrayBuffer support
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

/**
 * Set headers for manifest files
 *
 * Manifests use shorter cache times to allow for updates while still
 * providing reasonable caching. ETags are used for cache validation.
 *
 * @param res - HTTP response object
 * @param filePath - Path to the manifest being served
 * @private
 */
function setManifestHeaders(
  res: { setHeader: (k: string, v: string) => void },
  _filePath: string,
): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Short cache with revalidation - manifests can change but shouldn't
  // cause excessive requests. 5 minutes cache, must revalidate after.
  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
  // CORS headers for client access
  res.setHeader("Access-Control-Allow-Origin", "*");
}

/**
 * Set headers for asset files
 *
 * Configures aggressive caching and MIME types for models, audio, etc.
 *
 * @param res - HTTP response object
 * @param filePath - Path to the asset being served
 * @private
 */
function setAssetHeaders(
  res: { setHeader: (k: string, v: string) => void },
  filePath: string,
): void {
  // Set MIME types
  if (filePath.endsWith(".wasm")) {
    res.setHeader("Content-Type", "application/wasm");
    res.setHeader("Accept-Ranges", "bytes");
  } else if (filePath.endsWith(".mp3")) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
  } else if (filePath.endsWith(".ogg")) {
    res.setHeader("Content-Type", "audio/ogg");
    res.setHeader("Accept-Ranges", "bytes");
  } else if (filePath.endsWith(".wav")) {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
  } else if (filePath.endsWith(".glb") || filePath.endsWith(".vrm")) {
    res.setHeader("Content-Type", "model/gltf-binary");
  }

  // Production: aggressive immutable caching (1 year).
  // Dev: short cache with revalidation so file changes are picked up on refresh.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Expires", new Date(Date.now() + 31536000000).toUTCString());
  } else {
    res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  }

  // CORS headers so cross-origin clients (e.g. Vite dev on :3333, RTMP bridge
  // browser) can fetch assets served from :5555 without triggering CORP blocks.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

/**
 * Register manual music route
 *
 * Workaround for static file serving issues with music files.
 * Tries multiple paths to find music files.
 *
 * @param fastify - Fastify instance
 * @param config - Server configuration
 * @private
 */
function registerMusicRoute(
  fastify: FastifyInstance,
  config: ServerConfig,
): void {
  fastify.get(
    "/assets/world/music/:category/:filename",
    async (request, reply) => {
      const { category, filename } = request.params as {
        category: string;
        filename: string;
      };

      // Validate inputs
      if (!/^\w+\.mp3$/.test(filename)) {
        return reply.code(400).send({ error: "Invalid filename" });
      }
      if (
        category !== "normal" &&
        category !== "combat" &&
        category !== "intro"
      ) {
        return reply.code(400).send({ error: "Invalid category" });
      }

      // Try primary path
      const primaryPath = path.join(
        config.assetsDir,
        "audio",
        "music",
        category,
        filename,
      );

      // Try alternate paths
      const pubCandidates = [
        path.join(config.__dirname, "../..", "public", "assets/world"),
        path.join(config.__dirname, "..", "public", "assets/world"),
        path.join(process.cwd(), "public", "assets/world"),
        path.join(
          process.cwd(),
          "packages",
          "hyperia",
          "public",
          "assets/world",
        ),
      ];

      // Try primary path first
      if (await fs.pathExists(primaryPath)) {
        reply.type("audio/mpeg");
        reply.header("Accept-Ranges", "bytes");
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
        return reply.send(fs.createReadStream(primaryPath));
      }

      // Try alternates
      for (const pubRoot of pubCandidates) {
        const altPath = path.join(
          pubRoot,
          "audio",
          "music",
          category,
          filename,
        );

        if (await fs.pathExists(altPath)) {
          reply.type("audio/mpeg");
          reply.header("Accept-Ranges", "bytes");
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
          return reply.send(fs.createReadStream(altPath));
        }
      }

      return reply.code(404).send({
        error: "Music file not found",
      });
    },
  );
  console.log("[HTTP] ✅ Manual music route registered");
}

/**
 * Log available assets for debugging
 *
 * @param fastify - Fastify instance
 * @param config - Server configuration
 * @private
 */
async function logAvailableAssets(
  fastify: FastifyInstance,
  config: ServerConfig,
): Promise<void> {
  const toolsDir = path.join(config.assetsDir, "models/tools");
  if (await fs.pathExists(toolsDir)) {
    const toolFiles = await fs.readdir(toolsDir);
    fastify.log.info(`[HTTP] Tools available: ${toolFiles.join(", ")}`);
  }

  const mobsDir = path.join(config.assetsDir, "models/mobs");
  if (await fs.pathExists(mobsDir)) {
    const mobFiles = await fs.readdir(mobsDir);
    fastify.log.info(`[HTTP] Mob models available: ${mobFiles.join(", ")}`);
  }
}

/**
 * Register SPA catch-all route
 *
 * For client-side routing, any route that doesn't match an API endpoint
 * or static file should serve index.html. This allows React Router or
 * similar client-side routers to handle the route.
 *
 * @param fastify - Fastify instance
 * @param config - Server configuration
 * @private
 */
async function registerSpaCatchAll(
  fastify: FastifyInstance,
  config: ServerConfig,
): Promise<void> {
  const publicInfo = await resolvePublicRoot(config);
  const indexHtmlPath = publicInfo.indexPath;

  // Check if index.html exists before registering catch-all
  if (!(await fs.pathExists(indexHtmlPath))) {
    console.log(
      "[HTTP] ⚠️  No index.html found for SPA catch-all, skipping route",
    );
    return;
  }

  fastify.setNotFoundHandler(
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!shouldServeSpaForRequestUrl(request.url)) {
        return reply.status(404).send({ error: "Not found" });
      }

      // Serve index.html for SPA routes
      const html = await fs.promises.readFile(indexHtmlPath, "utf-8");

      return reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-cache, no-store, must-revalidate")
        .header("Pragma", "no-cache")
        .header("Expires", "0")
        .send(html);
    },
  );

  console.log(
    `[HTTP] ✅ SPA catch-all route registered (${publicInfo.source})`,
  );
}
