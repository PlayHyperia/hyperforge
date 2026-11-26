import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  revokeAgentCredentialSessions,
  rotateAgentCredentialSession,
  verifyAgentCredentialSession,
} from "../agent-credential-sessions.js";
import { buildAgentCredentialJwtPayload } from "../../infrastructure/auth/agent-credential-session.js";

const connectionString = process.env.SOLANA_AGENT_AUTH_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("agent credential session PostgreSQL authority", () => {
  const pool = new pg.Pool({ connectionString, max: 8 });
  const accountIds = new Set<string>();
  const now = new Date("2026-08-27T13:00:00.000Z");

  const createIdentity = async () => {
    const accountId = `credential-test-${randomUUID()}`;
    const characterId = randomUUID();
    accountIds.add(accountId);
    await pool.query(
      `INSERT INTO "users" ("id", "name", "roles", "createdAt")
       VALUES ($1, 'Credential Test', 'player', $2)`,
      [accountId, now.toISOString()],
    );
    await pool.query(
      `INSERT INTO "characters" ("id", "accountId", "name", "isAgent", "createdAt")
       VALUES ($1, $2, 'Credential Agent', 1, $3)`,
      [characterId, accountId, now.getTime()],
    );
    return { accountId, characterId };
  };

  afterAll(async () => {
    if (accountIds.size > 0) {
      await pool.query(`DELETE FROM "users" WHERE "id" = ANY($1::text[])`, [
        [...accountIds],
      ]);
    }
    await pool.end();
  });

  it("issues one exact active session and validates only its bound claims", async () => {
    const identity = await createIdentity();
    const session = await rotateAgentCredentialSession({
      ...identity,
      authMethod: "owner-credential-v1",
      now,
      pool,
    });
    const payload = buildAgentCredentialJwtPayload(session);
    await expect(
      verifyAgentCredentialSession(payload, pool, new Date(now.getTime() + 1)),
    ).resolves.toMatchObject({ sessionId: session.sessionId });
    await expect(
      verifyAgentCredentialSession(
        { ...payload, characterId: "different-character" },
        pool,
        new Date(now.getTime() + 1),
      ),
    ).resolves.toBeNull();
  });

  it("atomically rotates the prior session and makes its old JWT unusable", async () => {
    const identity = await createIdentity();
    const first = await rotateAgentCredentialSession({
      ...identity,
      authMethod: "owner-credential-v1",
      now,
      pool,
    });
    const second = await rotateAgentCredentialSession({
      ...identity,
      authMethod: "sol-wallet-signature-v1",
      now: new Date(now.getTime() + 1_000),
      pool,
    });
    expect(second.revokedSessionIds).toEqual([first.sessionId]);
    await expect(
      verifyAgentCredentialSession(
        buildAgentCredentialJwtPayload(first),
        pool,
        new Date(now.getTime() + 2_000),
      ),
    ).resolves.toBeNull();
    await expect(
      verifyAgentCredentialSession(
        buildAgentCredentialJwtPayload(second),
        pool,
        new Date(now.getTime() + 2_000),
      ),
    ).resolves.toMatchObject({ sessionId: second.sessionId });
  });

  it("serializes concurrent rotations and leaves exactly one active session", async () => {
    const identity = await createIdentity();
    const sessions = await Promise.all([
      rotateAgentCredentialSession({
        ...identity,
        authMethod: "owner-credential-v1",
        now,
        pool,
      }),
      rotateAgentCredentialSession({
        ...identity,
        authMethod: "owner-credential-v1",
        now: new Date(now.getTime() + 1),
        pool,
      }),
    ]);
    const persisted = await pool.query<{
      active_count: string;
      total_count: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE "revoked_at" IS NULL)::text AS active_count,
              COUNT(*)::text AS total_count
         FROM "agent_credential_sessions"
        WHERE "account_id" = $1 AND "character_id" = $2`,
      [identity.accountId, identity.characterId],
    );
    expect(persisted.rows[0]).toEqual({
      active_count: "1",
      total_count: "2",
    });
    const validity = await Promise.all(
      sessions.map((session) =>
        verifyAgentCredentialSession(
          buildAgentCredentialJwtPayload(session),
          pool,
          new Date(now.getTime() + 2),
        ),
      ),
    );
    expect(validity.filter(Boolean)).toHaveLength(1);
  });

  it("revokes idempotently and prevents mutation of terminal evidence", async () => {
    const identity = await createIdentity();
    const session = await rotateAgentCredentialSession({
      ...identity,
      authMethod: "owner-credential-v1",
      now,
      pool,
    });
    await expect(
      revokeAgentCredentialSessions({
        ...identity,
        now: new Date(now.getTime() + 1_000),
        pool,
      }),
    ).resolves.toEqual([session.sessionId]);
    await expect(
      revokeAgentCredentialSessions({
        ...identity,
        now: new Date(now.getTime() + 2_000),
        pool,
      }),
    ).resolves.toEqual([]);
    await expect(
      pool.query(
        `UPDATE "agent_credential_sessions"
            SET "revoked_reason" = 'security_revoked'
          WHERE "session_id" = $1`,
        [session.sessionId],
      ),
    ).rejects.toThrow(/revoked agent credential session is immutable/u);
  });

  it("rejects ownership mismatch before rotating or revoking authority", async () => {
    const identity = await createIdentity();
    await expect(
      rotateAgentCredentialSession({
        accountId: "not-the-owner",
        authMethod: "owner-credential-v1",
        characterId: identity.characterId,
        now,
        pool,
      }),
    ).rejects.toThrow(/session is not available/u);
    await expect(
      revokeAgentCredentialSessions({
        accountId: "not-the-owner",
        characterId: identity.characterId,
        now,
        pool,
      }),
    ).rejects.toThrow(/session is not available/u);
  });
});
