/**
 * Upload Routes Module - File upload handling
 *
 * Handles file uploads from clients including validation, hashing,
 * and storage in the assets directory.
 *
 * Endpoints:
 * - POST /api/upload - Upload a file (multipart/form-data)
 * - GET /api/upload-check - Check if a file exists
 *
 * Features:
 * - Content-based hashing (same file = same hash)
 * - Automatic deduplication
 * - Extension validation
 * - Configurable storage directory
 *
 * Usage:
 * ```typescript
 * import { registerUploadRoutes } from './routes/upload-routes';
 * registerUploadRoutes(fastify, config);
 * ```
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "fs-extra";
import path from "path";
import { hashFile } from "../../shared/utils.js";
import type { ServerConfig } from "../config.js";
import {
  getUploadRateLimit,
  isRateLimitEnabled,
} from "../../infrastructure/rate-limit/rate-limit-config.js";
import { isProductionLikeEnvironment } from "../../infrastructure/http/origin-policy.js";

/**
 * Sanitize a filename to prevent path traversal attacks.
 * Only allows alphanumeric characters, hyphens, underscores, and a single dot for extension.
 * @param filename - The filename to sanitize
 * @returns Sanitized filename or null if invalid
 */
function sanitizeFilename(filename: string): string | null {
  if (!filename || typeof filename !== "string") {
    return null;
  }

  // Get just the basename (removes any path components)
  const basename = path.basename(filename);

  // Validate the filename format: must be alphanumeric hash + extension
  // Valid: abc123.png, deadbeef.glb
  // Invalid: ../file.png, file.png.exe, .htaccess
  const validPattern = /^[a-f0-9]+\.[a-z0-9]+$/i;
  if (!validPattern.test(basename)) {
    return null;
  }

  return basename;
}

/**
 * Register upload endpoints
 *
 * Sets up endpoints for file uploads and existence checks.
 * Files are hashed and stored in the assets directory with
 * content-based filenames for automatic deduplication.
 *
 * @param fastify - Fastify server instance
 * @param config - Server configuration
 */
export function registerUploadRoutes(
  fastify: FastifyInstance,
  config: ServerConfig,
): void {
  // Production assets are immutable deployment/CDN inputs. Keeping this legacy
  // filesystem writer out of the production route table removes an unnecessary
  // disk-exhaustion and executable-content boundary.
  if (isProductionLikeEnvironment(config.nodeEnv)) {
    console.log("[UploadRoutes] Production upload routes disabled");
    return;
  }

  // Build route config with rate limiting if enabled
  const uploadRouteConfig = isRateLimitEnabled()
    ? { config: { rateLimit: getUploadRateLimit() } }
    : {};

  // File upload endpoint
  fastify.post("/api/upload", uploadRouteConfig, async (req, _reply) => {
    const file = await req.file();
    if (!file) {
      throw new Error("No file uploaded");
    }

    const ext = file.filename.split(".").pop()?.toLowerCase();
    if (!ext) {
      throw new Error("Invalid filename");
    }

    // Create temp buffer to store contents
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Hash from buffer
    const hash = await hashFile(buffer);
    const filename = `${hash}.${ext}`;

    // Save to fs
    const filePath = path.join(config.assetsDir, filename);
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      await fs.writeFile(filePath, buffer);
    }

    return { filename, exists };
  });

  // Check if file exists
  fastify.get("/api/upload-check", async (req: FastifyRequest, _reply) => {
    const rawFilename = (req.query as { filename: string }).filename;

    // Sanitize filename to prevent path traversal attacks
    const filename = sanitizeFilename(rawFilename);
    if (!filename) {
      throw new Error("Invalid filename format");
    }

    const filePath = path.join(config.assetsDir, filename);

    // Double-check the resolved path is within assetsDir (defense in depth)
    const resolvedPath = path.resolve(filePath);
    const assetsResolved = path.resolve(config.assetsDir);
    if (!resolvedPath.startsWith(assetsResolved + path.sep)) {
      throw new Error("Invalid file path");
    }

    const exists = await fs.pathExists(filePath);
    return { exists };
  });
}
