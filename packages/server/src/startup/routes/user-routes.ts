/**
 * User Routes
 *
 * API endpoints for user management operations
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { World } from "@hyperforge/shared";
import type { DatabaseSystem } from "../../systems/DatabaseSystem/index.js";
import * as schema from "../../database/schema.js";
import { eq } from "drizzle-orm";
import { createDistributedRateLimitPreHandler } from "../../infrastructure/rate-limit/distributed-rate-limit.js";
import {
  requirePrivyRequestUser,
  verifyPrivyRequestUser,
} from "../../infrastructure/auth/http-auth.js";

/**
 * Rate limiter for user check endpoint to prevent enumeration attacks.
 */
interface CheckAttempt {
  count: number;
  resetTime: number;
}

const checkRateLimits = new Map<string, CheckAttempt>();

// Rate limit config: 30 checks per minute per IP
const CHECK_RATE_LIMIT = 30;
const CHECK_RATE_WINDOW_MS = 60 * 1000;

// Memory leak prevention: max entries and cleanup interval
const CHECK_RATE_MAX_ENTRIES = 50_000;
const CHECK_RATE_CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Periodic cleanup to prevent unbounded memory growth */
function cleanupStaleCheckAttempts(): void {
  const now = Date.now();

  for (const [ip, attempt] of checkRateLimits) {
    // Remove entries where the window has expired
    if (attempt.resetTime < now) {
      checkRateLimits.delete(ip);
    }
  }

  // If still over limit, remove oldest entries (by resetTime)
  if (checkRateLimits.size > CHECK_RATE_MAX_ENTRIES) {
    const entries = Array.from(checkRateLimits.entries()).sort(
      (a, b) => a[1].resetTime - b[1].resetTime,
    );
    const toRemove = entries.slice(0, entries.length - CHECK_RATE_MAX_ENTRIES);
    for (const [ip] of toRemove) {
      checkRateLimits.delete(ip);
    }
  }
}

// Start periodic cleanup (unref to not keep process alive)
const checkRateLimitCleanupTimer = setInterval(
  cleanupStaleCheckAttempts,
  CHECK_RATE_CLEANUP_INTERVAL_MS,
);
checkRateLimitCleanupTimer.unref?.();

/**
 * Check rate limit for /api/users/check endpoint.
 * Returns true if allowed, false if rate limited.
 */
function checkUserCheckRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempt = checkRateLimits.get(ip);

  if (!attempt || now >= attempt.resetTime) {
    checkRateLimits.set(ip, {
      count: 1,
      resetTime: now + CHECK_RATE_WINDOW_MS,
    });
    return true;
  }

  if (attempt.count >= CHECK_RATE_LIMIT) {
    return false;
  }

  attempt.count++;
  return true;
}

/**
 * Reserved usernames that cannot be used by players.
 * Includes system names, admin-related terms, and potentially confusing names.
 */
const RESERVED_USERNAMES = new Set([
  // Admin/System
  "admin",
  "administrator",
  "system",
  "root",
  "server",
  "mod",
  "moderator",
  "staff",
  "support",
  "help",
  "official",
  // Game-related
  "hyperia",
  "player",
  "npc",
  "bot",
  "agent",
  "null",
  "undefined",
  "unknown",
  "anonymous",
  // Common test names
  "test",
  "testing",
  "debug",
  "dev",
  "development",
]);

/**
 * Check if a username is reserved.
 * Case-insensitive comparison.
 */
function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.toLowerCase());
}

/**
 * Register user-related API routes
 */
export function registerUserRoutes(
  fastify: FastifyInstance,
  world: World,
): void {
  const databaseSystem = world.getSystem(
    "database",
  ) as unknown as DatabaseSystem;

  if (!databaseSystem) {
    console.error("[UserRoutes] DatabaseSystem not found");
    return;
  }

  /**
   * GET /api/users/check
   *
   * Check if a user account exists.
   * Rate limited to prevent enumeration attacks.
   *
   * Query:
   *   - accountId: string - The user's Privy account ID
   *
   * Returns:
   *   - exists: boolean
   */
  fastify.get<{
    Querystring: { accountId?: string };
  }>(
    "/api/users/check",
    {
      preHandler: createDistributedRateLimitPreHandler({
        getPool: () => databaseSystem.getPool(),
        max: CHECK_RATE_LIMIT,
        scope: "user-existence-check",
        windowMs: CHECK_RATE_WINDOW_MS,
      }),
    },
    async (request, reply) => {
      // Keep the local counter as an inexpensive load-shedding layer. The
      // shared pre-handler above is authoritative across deployment replicas.
      const ip = request.ip;

      if (!checkUserCheckRateLimit(ip)) {
        return reply.status(429).send({
          exists: false,
          error: "Too many requests",
          retryAfter: CHECK_RATE_WINDOW_MS / 1000,
        });
      }

      const { accountId } = request.query;

      if (!accountId) {
        return reply.status(400).send({
          exists: false,
          error: "Missing accountId parameter",
        });
      }

      const authenticatedUserId = await requirePrivyRequestUser(
        request,
        reply,
        accountId,
      );
      if (!authenticatedUserId) return;

      try {
        const db = databaseSystem.getDb();
        if (!db) {
          return reply.status(500).send({
            exists: false,
            error: "Database not available",
          });
        }

        const user = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, accountId))
          .limit(1);

        return reply.send({
          exists: user.length > 0,
        });
      } catch (error) {
        console.error(`[UserRoutes] ❌ Error checking if user exists:`, error);
        return reply.status(500).send({
          exists: false,
          error: "Database error",
        });
      }
    },
  );

  /**
   * POST /api/users/create
   *
   * Create a new user account with username and main wallet.
   * This is called during signup after Privy authentication.
   *
   * Body:
   *   - accountId: string - The user's Privy account ID
   *   - username: string - The chosen username (3-16 chars, alphanumeric + underscore)
   *   - wallet: string - The main HD wallet address (index 0)
   *
   * Returns:
   *   - success: boolean
   *   - username: string
   *   - message: string
   */
  fastify.post<{
    Body: {
      accountId?: string;
      username?: string;
      wallet?: string;
    };
  }>("/api/users/create", async (request, reply) => {
    const { accountId, username, wallet } = request.body;

    // Validate input
    if (!accountId || !username || !wallet) {
      return reply.status(400).send({
        success: false,
        error: "Missing required fields: accountId, username, and wallet",
      });
    }

    const authenticatedUserId = await requirePrivyRequestUser(
      request,
      reply,
      accountId,
    );
    if (!authenticatedUserId) return;

    // Validate username format
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 16) {
      return reply.status(400).send({
        success: false,
        error: "Username must be 3-16 characters",
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
      return reply.status(400).send({
        success: false,
        error: "Username can only contain letters, numbers, and underscores",
      });
    }

    // Check for reserved usernames
    if (isReservedUsername(trimmedUsername)) {
      return reply.status(400).send({
        success: false,
        error: "This username is reserved. Please choose another.",
      });
    }

    console.log(
      `[UserRoutes] 🎮 Creating user account: ${trimmedUsername} (${accountId})`,
    );

    try {
      // Check if user already exists
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const existingUser = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, accountId))
        .limit(1);

      if (existingUser.length > 0) {
        return reply.status(409).send({
          success: false,
          error: "Account already exists",
        });
      }

      // Check if username is taken
      const existingUsername = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.name, trimmedUsername))
        .limit(1);

      if (existingUsername.length > 0) {
        return reply.status(409).send({
          success: false,
          error: "Username is already taken. Please choose another.",
        });
      }

      // Create user account
      const timestamp = new Date().toISOString();
      await db.insert(schema.users).values({
        id: accountId,
        name: trimmedUsername,
        wallet,
        roles: "",
        createdAt: timestamp,
        avatar: null,
        privyUserId: accountId,
        farcasterFid: null,
      });

      console.log(
        `[UserRoutes] ✅ User account created: ${trimmedUsername} with wallet ${wallet}`,
      );

      return reply.send({
        success: true,
        username: trimmedUsername,
        message: "Account created successfully",
      });
    } catch (error) {
      console.error(
        "[UserRoutes] ❌ Failed to create user account for %s:",
        accountId,
        error,
      );

      return reply.status(500).send({
        success: false,
        error: "Failed to create account",
      });
    }
  });

  /**
   * POST /api/users/wallet
   *
   * Assign a wallet address to a user's account.
   * This is idempotent - calling multiple times with the same wallet is safe.
   *
   * SECURITY: Requires authentication. The authenticated user must match the accountId.
   *
   * Headers:
   *   - Authorization: Bearer <privy-token>
   *
   * Body:
   *   - accountId: string - The user's Privy account ID
   *   - wallet: string - The wallet address to assign (HD index 0)
   *
   * Returns:
   *   - success: boolean
   *   - message: string
   */
  fastify.post<{
    Body: {
      accountId?: string;
      wallet?: string;
    };
  }>("/api/users/wallet", async (request, reply) => {
    const { accountId, wallet } = request.body;

    // Validate input
    if (!accountId || !wallet) {
      return reply.status(400).send({
        success: false,
        error: "Missing required fields: accountId and wallet",
      });
    }

    // SECURITY: Verify authentication and ownership
    const authenticatedUserId = await verifyPrivyRequestUser(request);
    if (!authenticatedUserId) {
      return reply.status(401).send({
        success: false,
        error: "Authentication required",
      });
    }

    // SECURITY: User can only modify their own account
    if (authenticatedUserId !== accountId) {
      console.warn(
        `[UserRoutes] ⚠️ User ${authenticatedUserId} attempted to modify wallet for different account ${accountId}`,
      );
      return reply.status(403).send({
        success: false,
        error: "Cannot modify another user's account",
      });
    }

    console.log(
      `[UserRoutes] 💼 Assigning wallet ${wallet} to user ${accountId}`,
    );

    try {
      // Update user's wallet in database
      await databaseSystem.updateUserWallet(accountId, wallet);

      console.log(
        `[UserRoutes] ✅ Wallet assigned successfully to user ${accountId}`,
      );

      return reply.send({
        success: true,
        message: "Wallet assigned to user account",
      });
    } catch (error) {
      console.error(
        `[UserRoutes] ❌ Failed to assign wallet to user ${accountId}:`,
        error,
      );

      return reply.status(500).send({
        success: false,
        error: "Failed to assign wallet to user account",
      });
    }
  });
}
