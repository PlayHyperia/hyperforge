/**
 * Cloudflare Worker - Edge routing layer for production deployment
 *
 * This file runs on Cloudflare's global edge network and routes requests to:
 * - Game server containers (for WebSockets and API)
 * - R2 storage (for static assets)
 *
 * **Architecture**:
 * ```
 * Player → Cloudflare Edge (this file) → Game Server Container
 *                                      → R2 CDN (for assets)
 * ```
 *
 * **Request Routing**:
 * 1. `/ws` - WebSocket connections → Container (sticky session)
 * 2. `/api/*` - API calls → Container (load balanced)
 * 3. `/assets/world/*` - Static assets → R2 (bypasses container entirely!)
 * 4. Everything else → Container (HTML, scripts, etc.)
 *
 * **Why this architecture?**:
 * - **Edge routing** = Lower latency (route at closest datacenter)
 * - **Container separation** = Game logic isolated from static content
 * - **R2 for assets** = Infinite scalability for music/models/textures
 * - **Auto-scaling** = Spin up 1-5 container instances based on load
 *
 * **Container Management**:
 * Uses Cloudflare's Container Runtime (Durable Objects):
 * - Automatically scales between 1-5 instances
 * - Uses `getRandom()` for simple load balancing
 * - Containers sleep after 30 minutes of inactivity (saves money)
 * - WebSocket connections are sticky to container instance
 *
 * **R2 Storage**:
 * Static assets (music, 3D models, textures) are stored in Cloudflare R2:
 * - Unlimited bandwidth (no egress fees!)
 * - Range requests for audio streaming
 * - Proper MIME types for all asset formats
 * - Aggressive caching (immutable content)
 *
 * **Performance Optimizations**:
 * - Assets bypass container (faster, cheaper)
 * - CORS headers allow cross-origin requests
 * - Gzip/Brotli compression handled by Cloudflare automatically
 * - Edge caching for static content
 *
 * **Development vs Production**:
 * - Development: Uses index.ts directly (no worker needed)
 * - Production: Deploys this worker to Cloudflare (wrangler.toml config)
 *
 * **Referenced by**: wrangler.toml (Cloudflare deployment config)
 */

import { Container, getRandom } from "@cloudflare/containers";
import { prepareOriginRequest } from "./origin-request.js";

// ============================================================================
// CLOUDFLARE WORKER TYPE DEFINITIONS
// ============================================================================
// TypeScript definitions for Cloudflare Workers runtime APIs

/** Cloudflare Request with cf property */
interface CloudflareRequest extends Request {
  cf?: {
    colo?: string;
    country?: string;
    city?: string;
    continent?: string;
    latitude?: string;
    longitude?: string;
    postalCode?: string;
    metroCode?: string;
    region?: string;
    regionCode?: string;
    timezone?: string;
  };
}

/** Durable Object namespace for container management */
type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

/** Unique identifier for a Durable Object (container instance) */
type DurableObjectId = {
  toString(): string;
  equals(other: DurableObjectId): boolean;
};

/** Handle for communicating with a Durable Object instance */
type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

/** Cloudflare R2 storage bucket interface */
type R2Bucket = {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<void>;
  delete(key: string): Promise<void>;
};

type R2Object = {
  body: ReadableStream;
  size: number;
  httpMetadata?: Record<string, string>;
};

type D1Database = {
  prepare(query: string): D1PreparedStatement;
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  all(): Promise<{ results: unknown[] }>;
  first(): Promise<unknown>;
  run(): Promise<void>;
};

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

/**
 * Worker environment bindings
 *
 * These are injected by Cloudflare Workers runtime and configured in wrangler.toml.
 * Provides access to:
 * - Durable Objects (game server containers)
 * - R2 buckets (asset storage)
 * - Environment variables (secrets)
 * - D1 databases (optional - not currently used)
 * - KV namespaces (optional - not currently used)
 */
interface Env {
  GAME_SERVER: DurableObjectNamespace;
  ASSETS: R2Bucket;
  UPLOADS: R2Bucket;
  DB?: D1Database;
  SESSIONS?: KVNamespace;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  PRIVY_APP_SECRET: string;
  DATABASE_URL: string;
  PUBLIC_CDN_URL: string;
  /** Edge-owned credential injected into every request sent to the origin. */
  CLOUDFLARE_ORIGIN_SECRET?: string;
}

/**
 * GameServer container class
 *
 * Defines how Cloudflare should run the Hyperia server Docker container.
 * Containers are auto-scaled based on load (1-5 instances).
 *
 * @public
 */
class GameServer extends Container {
  /** Port the server listens on inside the container */
  defaultPort = 8080;

  /** Sleep container after 30 minutes of inactivity to save costs */
  sleepAfter = "30m";
}

/**
 * Cloudflare Worker request handler
 *
 * Routes incoming requests to the appropriate backend:
 * - WebSocket → Game server container
 * - API routes → Game server container
 * - Static assets → R2 CDN (bypasses container for performance)
 * - Everything else → Game server container
 *
 * This edge layer provides load balancing and CDN acceleration.
 *
 * @public
 */
export default {
  /**
   * Handles all incoming HTTP requests
   *
   * @param request - Incoming HTTP request
   * @param env - Environment bindings (R2, containers, secrets)
   * @param _ctx - Execution context for waitUntil
   * @returns HTTP response
   */
  async fetch(
    request: CloudflareRequest,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // ===== HEALTH CHECK (Edge level) =====
    if (url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        layer: "cloudflare-edge",
        timestamp: new Date().toISOString(),
        region: request.cf?.colo || "unknown",
      });
    }

    // ===== WEBSOCKET → Game Server Container =====
    if (url.pathname === "/ws") {
      // Get a container instance (Cloudflare auto-balances load)
      // Using getRandom for now - Cloudflare will add smarter routing soon
      const MAX_INSTANCES = 5;
      const container = await getRandom(env.GAME_SERVER, MAX_INSTANCES);

      // Forward WebSocket upgrade to container
      return container.fetch(
        prepareOriginRequest(request, env.CLOUDFLARE_ORIGIN_SECRET),
      );
    }

    // ===== API ROUTES → Game Server Container =====
    if (url.pathname.startsWith("/api/")) {
      const container = await getRandom(env.GAME_SERVER, 5);
      return container.fetch(
        prepareOriginRequest(request, env.CLOUDFLARE_ORIGIN_SECRET),
      );
    }

    // ===== STATIC ASSETS → R2 CDN (Bypass container!) =====
    if (url.pathname.startsWith("/assets/world/")) {
      const assetPath = url.pathname.replace("/assets/world/", "");

      // Fetch from R2
      const object = await env.ASSETS.get(assetPath);

      if (!object) {
        return Response.json(
          { error: "Asset not found", path: assetPath },
          { status: 404 },
        );
      }

      // Determine content type from extension
      let contentType = "application/octet-stream";
      const ext = assetPath.split(".").pop()?.toLowerCase();

      switch (ext) {
        case "mp3":
          contentType = "audio/mpeg";
          break;
        case "ogg":
          contentType = "audio/ogg";
          break;
        case "wav":
          contentType = "audio/wav";
          break;
        case "glb":
          contentType = "model/gltf-binary";
          break;
        case "gltf":
          contentType = "model/gltf+json";
          break;
        case "json":
          contentType = "application/json";
          break;
        case "png":
          contentType = "image/png";
          break;
        case "jpg":
        case "jpeg":
          contentType = "image/jpeg";
          break;
        case "webp":
          contentType = "image/webp";
          break;
        case "vrm":
          contentType = "model/vrm";
          break;
        default:
          contentType = "application/octet-stream";
      }

      const headers = new Headers();
      headers.set("Content-Type", contentType);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headers.set("Accept-Ranges", "bytes");

      // Handle range requests for audio/video streaming
      const range = request.headers.get("Range");
      if (range) {
        const size = object.size;
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0]!, 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;

        headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
        headers.set("Content-Length", String(end - start + 1));

        return new Response(object.body, {
          status: 206,
          headers,
        });
      }

      headers.set("Content-Length", String(object.size));

      return new Response(object.body, { headers });
    }

    // ===== CORS Preflight =====
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, solana-client",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // ===== EVERYTHING ELSE → Container =====
    // This includes: /, /env.js, /upload, etc.
    const container = await getRandom(env.GAME_SERVER, 5);
    return container.fetch(
      prepareOriginRequest(request, env.CLOUDFLARE_ORIGIN_SECRET),
    );
  },
};

// Export the container class
export { GameServer };
