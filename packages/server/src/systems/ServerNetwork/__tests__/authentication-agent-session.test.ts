import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentCredentialJwtPayload } from "../../../infrastructure/auth/agent-credential-session.js";

const authMocks = vi.hoisted(() => ({
  payload: {} as Record<string, unknown> | null,
}));

vi.mock("../../../shared/utils", () => ({
  createJWT: vi.fn(async () => "created-token"),
  verifyJWT: vi.fn(async () => authMocks.payload),
}));

vi.mock("../../../infrastructure/auth/privy-auth", () => ({
  isPrivyEnabled: () => false,
  verifyPrivyToken: vi.fn(),
}));

import {
  AgentCredentialAuthenticationError,
  authenticateUser,
  PresentedCredentialAuthenticationError,
} from "../authentication.js";

const session = {
  accountId: "account-1",
  authMethod: "owner-credential-v1" as const,
  characterId: "character-1",
  expiresAt: "2099-09-03T12:00:00.000Z",
  sessionId: "00000000-0000-4000-8000-000000000001",
};

function createDatabase(
  options: { revoked?: boolean; userRoles?: string } = {},
) {
  const calls: string[] = [];
  const db = vi.fn((table: string) => {
    calls.push(table);
    const builder = {
      first: vi.fn(async () => {
        if (table === "agent_credential_sessions") {
          return {
            account_id: session.accountId,
            auth_method: session.authMethod,
            character_id: session.characterId,
            expires_at: session.expiresAt,
            revoked_at: options.revoked ? new Date() : null,
            session_id: session.sessionId,
          };
        }
        if (table === "users") {
          return {
            id: session.accountId,
            name: "Agent",
            roles: options.userRoles ?? "player",
            createdAt: "2026-08-27T12:00:00.000Z",
          };
        }
        return undefined;
      }),
      insert: vi.fn(async () => undefined),
      orWhere: vi.fn(),
      select: vi.fn(),
      where: vi.fn(),
      whereNull: vi.fn(),
    };
    builder.where.mockReturnValue(builder);
    builder.orWhere.mockReturnValue(builder);
    builder.select.mockReturnValue(builder);
    builder.whereNull.mockReturnValue(builder);
    return builder;
  });
  return { calls, db: db as never };
}

describe("WebSocket agent credential session authority", () => {
  beforeEach(() => {
    authMocks.payload = buildAgentCredentialJwtPayload(session);
  });

  it("binds an active database session to the authenticated socket identity", async () => {
    const { db } = createDatabase();
    await expect(
      authenticateUser({ authToken: "agent-token" }, db),
    ).resolves.toMatchObject({
      agentCredentialCharacterId: session.characterId,
      agentCredentialSessionExpiresAt: session.expiresAt,
      agentCredentialSessionId: session.sessionId,
      user: { id: session.accountId },
    });
  });

  it("rejects a revoked agent token instead of degrading it to anonymous access", async () => {
    const { db } = createDatabase({ revoked: true });
    await expect(
      authenticateUser({ authToken: "revoked-agent-token" }, db),
    ).rejects.toBeInstanceOf(AgentCredentialAuthenticationError);
  });

  it("does not impose agent-session persistence on an ordinary human JWT", async () => {
    authMocks.payload = { userId: session.accountId };
    const { calls, db } = createDatabase();
    await expect(
      authenticateUser({ authToken: "human-token" }, db),
    ).resolves.toMatchObject({
      agentCredentialCharacterId: undefined,
      agentCredentialSessionId: undefined,
      user: { id: session.accountId },
    });
    expect(calls).not.toContain("agent_credential_sessions");
  });

  it("rejects a legacy stateless JWT for a persisted agent-role account", async () => {
    authMocks.payload = { userId: session.accountId };
    const { db } = createDatabase({ userRoles: "agent" });
    await expect(
      authenticateUser({ authToken: "legacy-agent-token" }, db),
    ).rejects.toBeInstanceOf(AgentCredentialAuthenticationError);
  });

  it("rejects an invalid or retired presented token instead of degrading to anonymous", async () => {
    authMocks.payload = null;
    const { db } = createDatabase();

    await expect(
      authenticateUser({ authToken: "retired-key-token" }, db),
    ).rejects.toBeInstanceOf(PresentedCredentialAuthenticationError);
  });
});
