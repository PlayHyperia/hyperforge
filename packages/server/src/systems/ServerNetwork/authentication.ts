/**
 * Authentication Module
 *
 * Handles user authentication through multiple providers:
 * - Privy (wallet and social authentication)
 * - Legacy JWT (custom token authentication)
 * - Anonymous users (fallback)
 * - Load test mode (in-memory users, no DB)
 *
 * Also handles ban checking to prevent banned users from connecting.
 *
 * This module extracts all authentication logic from ServerNetwork
 * to improve maintainability and testability.
 */

import type {
  ConnectionParams,
  User,
  SystemDatabase,
} from "../../shared/types";
import {
  isPrivyEnabled,
  verifyPrivyToken,
} from "../../infrastructure/auth/privy-auth";
import { createJWT, verifyJWT } from "../../shared/utils";
import { uuid } from "@hyperforge/shared";
import { errMsg } from "../../shared/errMsg.js";
import { verifyAgentCredentialSessionWithSystemDatabase } from "../../database/agent-credential-sessions.js";

export class AgentCredentialAuthenticationError extends Error {
  constructor() {
    super("Agent credential authentication failed");
    this.name = "AgentCredentialAuthenticationError";
  }
}

export class PresentedCredentialAuthenticationError extends Error {
  constructor() {
    super("Presented credential authentication failed");
    this.name = "PresentedCredentialAuthenticationError";
  }
}

/**
 * Check if load test mode is enabled
 * When enabled, allows anonymous connections without database insertion
 */
export function isLoadTestMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    environment.LOAD_TEST_MODE === "true" &&
    environment.NODE_ENV !== "production"
  );
}

/**
 * Ban information returned when a user is banned
 */
export type BanInfo = {
  isBanned: boolean;
  reason?: string;
  expiresAt?: number | null;
  bannedByName?: string;
};

/**
 * Checks if a user is currently banned
 *
 * @param userId - The user ID to check
 * @param db - Database instance for ban lookups
 * @returns Ban information if banned, or { isBanned: false } if not banned
 */
export async function checkUserBan(
  userId: string,
  db: SystemDatabase,
): Promise<BanInfo> {
  try {
    const now = Date.now();

    // Query for active bans that haven't expired
    // A ban is active if: active=1 AND (expiresAt IS NULL OR expiresAt > now)
    // Type for ban query result
    type BanRow = {
      bannedByUserId?: string;
      reason?: string;
      expiresAt?: number | null;
    };

    const activeBan = (await db("user_bans")
      .where("bannedUserId", userId)
      .where("active", 1)
      .where(function (this: ReturnType<SystemDatabase>) {
        this.whereNull("expiresAt").orWhere("expiresAt", ">", now);
      })
      .first()) as BanRow | undefined;

    if (!activeBan) {
      return { isBanned: false };
    }

    // Get the name of who banned them (for the ban message)
    let bannedByName = "a moderator";
    if (activeBan.bannedByUserId) {
      const bannedByUser = (await db("users")
        .where("id", activeBan.bannedByUserId)
        .select("name")
        .first()) as { name?: string } | undefined;
      if (bannedByUser?.name) {
        bannedByName = bannedByUser.name;
      }
    }

    return {
      isBanned: true,
      reason: activeBan.reason || undefined,
      expiresAt: activeBan.expiresAt || null,
      bannedByName,
    };
  } catch (err) {
    // ONLY allow connection if the error is specifically about missing table
    // This prevents security bypass if database has other issues
    const errorMessage = errMsg(err);

    // DrizzleQueryError wraps the original PG error in cause - check both
    type ErrorWithCause = Error & {
      cause?: Error & { code?: string; message?: string };
    };
    const cause =
      err instanceof Error ? (err as ErrorWithCause).cause : undefined;
    const causeMessage = cause?.message || "";
    const causeCode = cause?.code || "";

    // Combine main error message with cause message for detection
    const fullErrorText = `${errorMessage} ${causeMessage}`;

    const isTableMissing =
      fullErrorText.includes("user_bans") &&
      (fullErrorText.includes("does not exist") ||
        fullErrorText.includes("no such table") ||
        fullErrorText.includes("relation") ||
        fullErrorText.includes("42P01") ||
        causeCode === "42P01"); // PostgreSQL error code for undefined table

    if (isTableMissing) {
      console.warn(
        "[Authentication] user_bans table does not exist - skipping ban check (run migrations)",
      );
      return { isBanned: false };
    }

    // For any other error, log it and DENY access to be safe
    console.error(
      "[Authentication] Ban check failed with unexpected error:",
      err,
    );
    console.error("[Authentication] DENYING ACCESS due to ban check failure");
    return {
      isBanned: true,
      reason: "Unable to verify ban status - please try again later",
    };
  }
}

/**
 * Authenticates a user from connection parameters
 *
 * Authentication flow:
 * 1. Try Privy authentication (if enabled and token provided)
 * 2. Fall back to legacy JWT authentication
 * 3. Reject a presented credential if neither verifier accepts it
 * 4. Create an anonymous user only when no credential was presented
 *
 * @param params - Connection parameters from WebSocket
 * @param db - Database instance for user lookups/creation
 * @returns Authenticated user and auth token
 */
export async function authenticateUser(
  params: ConnectionParams,
  db: SystemDatabase,
): Promise<{
  user: User;
  authToken: string;
  agentCredentialCharacterId?: string;
  agentCredentialSessionExpiresAt?: string;
  agentCredentialSessionId?: string;
  userWithPrivy?: User & {
    privyUserId?: string | null;
    farcasterFid?: string | null;
  };
}> {
  let authToken = params.authToken;
  const credentialWasPresented =
    typeof authToken === "string" && authToken.length > 0;
  const name = params.name;
  const avatar = params.avatar;
  const privyUserId = (params as { privyUserId?: string }).privyUserId;

  let user: User | undefined;
  let agentCredentialCharacterId: string | undefined;
  let agentCredentialSessionExpiresAt: string | undefined;
  let agentCredentialSessionId: string | undefined;
  let userWithPrivy:
    | (User & { privyUserId?: string | null; farcasterFid?: string | null })
    | undefined;

  // Try Privy authentication first if enabled
  if (isPrivyEnabled() && authToken && privyUserId) {
    try {
      const privyInfo = await verifyPrivyToken(authToken);

      if (privyInfo && privyInfo.privyUserId === privyUserId) {
        let dbResult: User | undefined;
        try {
          dbResult = (await db("users")
            .where("privyUserId", privyUserId)
            .first()) as User | undefined;
        } catch (_e) {
          dbResult = (await db("users").where("id", privyUserId).first()) as
            User | undefined;
        }

        if (dbResult) {
          // Existing Privy user
          userWithPrivy = dbResult as User & {
            privyUserId?: string | null;
            farcasterFid?: string | null;
          };
          user = userWithPrivy;
        } else {
          // New Privy user - create account with stable id equal to privyUserId
          const timestamp = new Date().toISOString();
          const newUser: {
            id: string;
            name: string;
            avatar: string | null;
            roles: string;
            createdAt: string;
            privyUserId?: string;
            farcasterFid?: string;
          } = {
            id: privyInfo.privyUserId,
            name: name || "Adventurer",
            avatar: avatar || null,
            roles: "",
            createdAt: timestamp,
          };
          try {
            newUser.privyUserId = privyInfo.privyUserId;
            if (privyInfo.farcasterFid) {
              newUser.farcasterFid = privyInfo.farcasterFid;
            }
            await db("users").insert(newUser);
          } catch (_err) {
            await db("users").insert({
              id: newUser.id,
              name: newUser.name,
              avatar: newUser.avatar,
              roles: newUser.roles,
              createdAt: newUser.createdAt,
            });
          }
          userWithPrivy = newUser as User & {
            privyUserId?: string | null;
            farcasterFid?: string | null;
          };
          user = userWithPrivy;
        }

        // Generate a Hyperia JWT for this user
        authToken = await createJWT({ userId: (user as User).id });
      } else {
        console.warn(
          "[Authentication] Privy token verification failed or user ID mismatch",
        );
      }
    } catch (err) {
      // JWT expiration is expected behavior, not an error
      if (err instanceof Error && err.message.includes("exp")) {
        console.warn(
          "[Authentication] Privy token expired - user needs to re-authenticate",
        );
      } else if (
        err instanceof Error &&
        (err.message.includes("alg") || err.name === "JOSEAlgNotAllowed")
      ) {
        // Algorithm mismatch is expected when a Hyperia JWT is passed to Privy
        // This happens with agent tokens - silently fall through to Hyperia JWT verification
      } else {
        console.error("[Authentication] Privy authentication error:", err);
      }
      // Fall through to legacy authentication
    }
  }

  // Fall back to Hyperia JWT authentication if Privy didn't work
  if (!user && authToken) {
    try {
      const jwtPayload = await verifyJWT(authToken);
      if (jwtPayload && jwtPayload.userId) {
        if (jwtPayload.isAgent === true) {
          const credentialSession =
            await verifyAgentCredentialSessionWithSystemDatabase(
              jwtPayload,
              db,
            );
          if (!credentialSession) {
            throw new AgentCredentialAuthenticationError();
          }
          agentCredentialCharacterId = credentialSession.characterId;
          agentCredentialSessionExpiresAt = credentialSession.expiresAt;
          agentCredentialSessionId = credentialSession.sessionId;
        }
        // Look up user account
        let dbResult = (await db("users")
          .where("id", jwtPayload.userId as string)
          .first()) as User | undefined;

        // If user doesn't exist for a valid server-signed JWT userId, create
        // a minimal user record so accountId remains stable across reconnects.
        if (!dbResult) {
          const timestamp = new Date().toISOString();
          const jwtUserId = jwtPayload.userId as string;
          const newUser = {
            id: jwtUserId,
            name:
              name ||
              (jwtUserId.startsWith("did:privy:") ? "Adventurer" : "Agent"),
            avatar: avatar || null,
            roles: "",
            createdAt: timestamp,
            privyUserId: jwtUserId.startsWith("did:privy:")
              ? jwtUserId
              : undefined,
          };

          try {
            await db("users").insert(newUser);
            dbResult = newUser as User;
          } catch (insertErr) {
            console.error(
              "[Authentication] Failed to create user record:",
              insertErr,
            );
            // Try fetching again in case of race condition
            dbResult = (await db("users")
              .where("id", jwtPayload.userId as string)
              .first()) as User | undefined;
          }
        }

        const persistedRoles = dbResult?.roles;
        const isPersistedAgentAccount = Array.isArray(persistedRoles)
          ? persistedRoles.includes("agent")
          : typeof persistedRoles === "string" &&
            persistedRoles
              .split(",")
              .map((role) => role.trim())
              .includes("agent");
        if (isPersistedAgentAccount && jwtPayload.isAgent !== true) {
          throw new AgentCredentialAuthenticationError();
        }

        if (dbResult) {
          user = dbResult as User;
        }
      }
    } catch (err) {
      if (err instanceof AgentCredentialAuthenticationError) {
        throw err;
      }
      console.error(
        "[Authentication] Failed to verify a presented authentication token:",
        err,
      );
    }
  }

  if (!user && credentialWasPresented) {
    throw new PresentedCredentialAuthenticationError();
  }

  // Create anonymous user if no authentication succeeded
  if (!user) {
    const timestamp = new Date().toISOString();

    // Check if this is a load test bot (URL params come as strings)
    const loadTestBotParam = (params as { loadTestBot?: string | boolean })
      .loadTestBot;
    const isLoadTestBot =
      loadTestBotParam === "true" || loadTestBotParam === true;
    const botName = (params as { botName?: string }).botName;

    user = {
      id: uuid(),
      name: isLoadTestBot && botName ? botName : "Anonymous",
      avatar: null,
      roles: "",
      createdAt: timestamp,
    };

    // In load test mode with load test bots, skip database insertion for performance
    // This allows spawning thousands of bots without DB overhead
    if (isLoadTestMode() && isLoadTestBot) {
      console.log(
        `[Authentication] Load test bot authenticated: ${user.name} (${user.id})`,
      );
    } else {
      // Normal anonymous user - insert into database
      await db("users").insert({
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        roles: Array.isArray(user.roles) ? user.roles.join(",") : user.roles,
        createdAt: timestamp,
      });
    }
    authToken = await createJWT({ userId: user.id });
  }

  // Convert roles string to array - DB stores as string, runtime uses array
  if ((user.roles as string).split) {
    user.roles = (user.roles as string).split(",").filter((r) => r);
  }

  // SECURITY: Only grant dev admin when EXPLICITLY opted in
  // Requires GRANT_DEV_ADMIN=true AND development mode AND no admin code
  // This prevents accidental admin grants in misconfigured environments
  if (
    process.env.GRANT_DEV_ADMIN === "true" &&
    process.env.NODE_ENV === "development" &&
    !process.env.ADMIN_CODE
  ) {
    console.warn(
      "[Authentication] GRANT_DEV_ADMIN=true - granting temporary admin access (dev only)",
    );
    if (Array.isArray(user.roles)) {
      user.roles.push("~admin");
    }
  }

  return {
    user,
    authToken: authToken || "",
    agentCredentialCharacterId,
    agentCredentialSessionExpiresAt,
    agentCredentialSessionId,
    userWithPrivy,
  };
}

/**
 * True when connection params carry a cryptographically valid identity (Privy access token
 * + matching privyUserId, or valid Hyperia JWT) and the user is not banned.
 *
 * Used only for `mode=streaming` when public stream delay is enabled (`STREAMING_PUBLIC_DELAY_MS` > 0): anonymous
 * public viewers stay on the delayed surface, while logged-in accounts can open a
 * real-time streaming WebSocket without relying on loopback IP or `streamToken`.
 */
export async function verifyStreamingViewerCredentials(
  params: ConnectionParams,
  db: SystemDatabase,
): Promise<boolean> {
  const authToken = params.authToken;
  const privyUserId = params.privyUserId;
  if (!authToken || authToken.length === 0) return false;

  let resolvedUserId: string | undefined;

  if (isPrivyEnabled() && privyUserId) {
    try {
      const privyInfo = await verifyPrivyToken(authToken);
      if (privyInfo && privyInfo.privyUserId === privyUserId) {
        resolvedUserId = privyInfo.privyUserId;
      }
    } catch {
      // Wrong token type or network — try Hyperia JWT below
    }
  }

  if (!resolvedUserId) {
    try {
      const jwtPayload = await verifyJWT(authToken);
      if (jwtPayload && jwtPayload.userId) {
        if (jwtPayload.isAgent === true) {
          const credentialSession =
            await verifyAgentCredentialSessionWithSystemDatabase(
              jwtPayload,
              db,
            );
          if (!credentialSession) return false;
        } else {
          const persistedUser = (await db("users")
            .where("id", jwtPayload.userId as string)
            .first()) as { roles?: string | string[] } | undefined;
          const roles = persistedUser?.roles;
          if (
            (Array.isArray(roles) && roles.includes("agent")) ||
            (typeof roles === "string" &&
              roles
                .split(",")
                .map((role) => role.trim())
                .includes("agent"))
          ) {
            return false;
          }
        }
        resolvedUserId = jwtPayload.userId as string;
      }
    } catch {
      return false;
    }
  }

  if (!resolvedUserId) return false;

  const banInfo = await checkUserBan(resolvedUserId, db);
  return !banInfo.isBanned;
}
