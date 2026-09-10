import { describe, expect, it, vi } from "vitest";
import {
  verifyAgentCredentialSession,
  verifyAgentCredentialSessionWithSystemDatabase,
} from "../agent-credential-sessions.js";
import { createDrizzleAdapter } from "../adapter.js";
import { buildAgentCredentialJwtPayload } from "../../infrastructure/auth/agent-credential-session.js";

const now = new Date("2026-08-27T12:00:00.000Z");
const session = {
  accountId: "account-1",
  authMethod: "owner-credential-v1" as const,
  characterId: "character-1",
  expiresAt: "2026-09-03T12:00:00.000Z",
  sessionId: "00000000-0000-4000-8000-000000000001",
};
const payload = buildAgentCredentialJwtPayload(session);
const activeRow = {
  account_id: session.accountId,
  auth_method: session.authMethod,
  character_id: session.characterId,
  expires_at: session.expiresAt,
  revoked_at: null,
  session_id: session.sessionId,
};

describe("agent credential session verification", () => {
  it("accepts only the exact active PostgreSQL session row", async () => {
    const authority = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [activeRow] })),
    };
    await expect(
      verifyAgentCredentialSession(payload, authority as never, now),
    ).resolves.toMatchObject({ sessionId: session.sessionId });
    expect(authority.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "agent_credential_sessions"'),
      [session.sessionId],
    );
  });

  it.each([
    ["missing", undefined],
    ["revoked", { ...activeRow, revoked_at: now }],
    ["expired", { ...activeRow, expires_at: now }],
    ["account drift", { ...activeRow, account_id: "other" }],
    ["character drift", { ...activeRow, character_id: "other" }],
    ["method drift", { ...activeRow, auth_method: "other" }],
    ["expiry drift", { ...activeRow, expires_at: "2026-09-03T12:00:01.000Z" }],
  ])("rejects a %s row", async (_name, row) => {
    const authority = {
      query: vi.fn(async () => ({
        rowCount: row ? 1 : 0,
        rows: row ? [row] : [],
      })),
    };
    await expect(
      verifyAgentCredentialSession(payload, authority as never, now),
    ).resolves.toBeNull();
  });

  it("uses the same fail-closed comparison through the live SystemDatabase adapter", async () => {
    const first = vi.fn(async () => activeRow);
    const where = vi.fn(() => ({ first }));
    const db = vi.fn(() => ({ where }));
    await expect(
      verifyAgentCredentialSessionWithSystemDatabase(payload, db as never, now),
    ).resolves.toMatchObject({ sessionId: session.sessionId });
    expect(db).toHaveBeenCalledWith("agent_credential_sessions");
    expect(where).toHaveBeenCalledWith("session_id", session.sessionId);
  });

  it("authenticates through the production Drizzle compatibility adapter", async () => {
    const limit = vi.fn(async () => [
      {
        sessionId: session.sessionId,
        accountId: session.accountId,
        characterId: session.characterId,
        authMethod: session.authMethod,
        issuedAt: new Date("2026-08-27T11:59:59.000Z"),
        expiresAt: new Date(session.expiresAt),
        revokedAt: null,
        revokedReason: null,
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = createDrizzleAdapter({ select } as never);

    await expect(
      verifyAgentCredentialSessionWithSystemDatabase(payload, db, now),
    ).resolves.toMatchObject({ sessionId: session.sessionId });
    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
  });
});
