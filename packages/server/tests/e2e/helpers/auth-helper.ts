/**
 * Authentication Helper for Tests
 *
 * Generates valid JWT tokens for testing without needing Privy authentication.
 * Uses the same JWT secret and signing logic as the production server.
 */

import { randomBytes } from "crypto";
import jsonwebtoken from "jsonwebtoken";
import {
  HYPERIA_JWT_ALGORITHM,
  HYPERIA_JWT_AUDIENCE,
  HYPERIA_JWT_ISSUER,
  resolveJwtSigningKeyAuthority,
} from "../../../src/infrastructure/auth/jwt-signing-key-authority.js";

const DEFAULT_SERVER_URL =
  process.env.PUBLIC_API_URL ||
  process.env.SERVER_URL ||
  "http://localhost:5555";

/**
 * Create a test JWT token for authenticated testing
 *
 * @param userId - User/account ID (like Privy user ID)
 * @param characterId - Character UUID
 * @param isAgent - Whether this is an agent token
 * @returns Signed JWT token
 */
export function createTestJWT(
  userId: string,
  characterId: string,
  isAgent: boolean = false,
): string {
  const authority = resolveJwtSigningKeyAuthority();
  const options: jsonwebtoken.SignOptions = {
    algorithm: HYPERIA_JWT_ALGORITHM,
    expiresIn: "7d",
  };
  if (authority.mode === "key-ring") {
    options.audience = HYPERIA_JWT_AUDIENCE;
    options.issuer = HYPERIA_JWT_ISSUER;
    options.keyid = authority.activeKeyId;
  }
  return jsonwebtoken.sign(
    {
      userId,
      characterId,
      isAgent,
    },
    authority.activeSecret,
    options,
  );
}

/**
 * Create test user credentials with character
 *
 * @returns Test user data
 */
export function createTestUser() {
  const userId = `test-user-${Date.now()}`;
  const characterId = `test-char-${Date.now()}`;
  const token = createTestJWT(userId, characterId, false);

  return {
    userId,
    characterId,
    token,
  };
}

/**
 * Create test agent credentials
 *
 * @returns Test agent data
 */
export function createTestAgent() {
  const userId = `test-agent-user-${Date.now()}`;
  const characterId = `test-agent-char-${Date.now()}`;
  const token = createTestJWT(userId, characterId, true);

  return {
    userId,
    characterId,
    token,
    isAgent: true,
  };
}

/**
 * Create a user in the database via API
 * This is required before creating characters or agent mappings due to foreign key constraints.
 *
 * @param userId - User account ID
 * @param username - Username (defaults to generated name)
 * @param wallet - Wallet address (defaults to generated address)
 * @param serverUrl - Server URL (defaults to localhost:5555)
 * @returns Success status
 */
export async function createUserInDatabase(
  userId: string,
  username?: string,
  wallet?: string,
  serverUrl: string = DEFAULT_SERVER_URL,
): Promise<boolean> {
  try {
    const requestBody = {
      accountId: userId,
      username: username || `test${Date.now().toString().slice(-8)}`, // Max 12 chars (test + 8 digits)
      wallet: wallet || `0xTEST${Date.now()}`,
    };

    const response = await fetch(`${serverUrl}/api/users/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    return (
      response.ok ||
      (data as { error?: string }).error === "Account already exists"
    );
  } catch (error) {
    console.error("[AuthHelper] Failed to create user in database:", error);
    return false;
  }
}

/**
 * Create a character in the database via direct database access
 * Characters are normally created via WebSocket enterWorld packet,
 * but for API testing we need to create them directly.
 *
 * @param accountId - User account ID (must exist in users table)
 * @param characterName - Character name
 * @param avatar - Avatar URL (optional)
 * @param wallet - Wallet address (optional)
 * @param serverUrl - Server URL (defaults to localhost:5555)
 * @returns Character data if successful, null otherwise
 */
export async function createCharacterInDatabase(
  accountId: string,
  characterName: string,
  avatar?: string,
  wallet?: string,
  serverUrl: string = DEFAULT_SERVER_URL,
): Promise<{ id: string; name: string } | null> {
  try {
    const requestBody = {
      accountId,
      name: characterName,
      avatar: avatar || "default-avatar.vrm",
      wallet: wallet || `0xCHAR${Date.now()}`,
    };

    const response = await fetch(`${serverUrl}/api/characters/db`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        character: { id: string; name: string };
      };
      return data.character;
    }

    console.error("[AuthHelper] Character creation failed:", response.status);
    return null;
  } catch (error) {
    console.error(
      "[AuthHelper] Failed to create character in database:",
      error,
    );
    return null;
  }
}
