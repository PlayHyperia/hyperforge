import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { SystemDatabase } from "../shared/types/index.js";
import {
  AGENT_CREDENTIAL_SESSION_TTL_MS,
  parseAgentCredentialClaims,
  type AgentCredentialAuthMethod,
  type AgentCredentialSession,
} from "../infrastructure/auth/agent-credential-session.js";

type QueryResult<Row> = {
  rowCount: number | null;
  rows: Row[];
};

export interface AgentCredentialQueryAuthority {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface AgentCredentialSessionPool {
  connect(): Promise<
    AgentCredentialQueryAuthority & Pick<PoolClient, "release">
  >;
}

type AgentCredentialSessionRow = {
  account_id: string;
  auth_method: string;
  character_id: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  session_id: string;
};

export class AgentCredentialSessionRejectedError extends Error {
  constructor(message = "Agent credential session is not available") {
    super(message);
    this.name = "AgentCredentialSessionRejectedError";
  }
}

function normalizeNow(now?: Date): Date {
  const normalized = now ? new Date(now) : new Date();
  if (!Number.isFinite(normalized.getTime())) {
    throw new AgentCredentialSessionRejectedError();
  }
  return normalized;
}

function readTimestamp(value: Date | string): Date | null {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

async function withTransaction<T>(
  pool: AgentCredentialSessionPool,
  callback: (client: AgentCredentialQueryAuthority) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the first authority failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function rotateAgentCredentialSessionWithClient(
  client: AgentCredentialQueryAuthority,
  input: {
    accountId: string;
    authMethod: AgentCredentialAuthMethod;
    characterId: string;
    now?: Date;
  },
): Promise<AgentCredentialSession> {
  const now = normalizeNow(input.now);
  const character = await client.query<{ id: string }>(
    `SELECT "id"
       FROM "characters"
      WHERE "id" = $1 AND "accountId" = $2
      FOR UPDATE`,
    [input.characterId, input.accountId],
  );
  if (character.rows.length !== 1) {
    throw new AgentCredentialSessionRejectedError();
  }

  const revoked = await client.query<{ session_id: string }>(
    `UPDATE "agent_credential_sessions"
        SET "revoked_at" = $3,
            "revoked_reason" = 'rotated'
      WHERE "account_id" = $1
        AND "character_id" = $2
        AND "revoked_at" IS NULL
      RETURNING "session_id"`,
    [input.accountId, input.characterId, now],
  );

  const sessionId = randomUUID();
  const expiresAt = new Date(now.getTime() + AGENT_CREDENTIAL_SESSION_TTL_MS);
  await client.query(
    `INSERT INTO "agent_credential_sessions" (
       "session_id", "account_id", "character_id", "auth_method",
       "issued_at", "expires_at"
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sessionId,
      input.accountId,
      input.characterId,
      input.authMethod,
      now,
      expiresAt,
    ],
  );

  return {
    accountId: input.accountId,
    authMethod: input.authMethod,
    characterId: input.characterId,
    expiresAt: expiresAt.toISOString(),
    revokedSessionIds: revoked.rows.map((row) => row.session_id),
    sessionId,
  };
}

export async function rotateAgentCredentialSession(input: {
  accountId: string;
  authMethod: AgentCredentialAuthMethod;
  characterId: string;
  now?: Date;
  pool: AgentCredentialSessionPool;
}): Promise<AgentCredentialSession> {
  return withTransaction(input.pool, (client) =>
    rotateAgentCredentialSessionWithClient(client, input),
  );
}

export async function revokeAgentCredentialSessions(input: {
  accountId: string;
  characterId: string;
  now?: Date;
  pool: AgentCredentialSessionPool;
  reason?: "owner_revoked" | "security_revoked";
}): Promise<string[]> {
  return withTransaction(input.pool, async (client) => {
    const now = normalizeNow(input.now);
    const character = await client.query<{ id: string }>(
      `SELECT "id"
         FROM "characters"
        WHERE "id" = $1 AND "accountId" = $2
        FOR UPDATE`,
      [input.characterId, input.accountId],
    );
    if (character.rows.length !== 1) {
      throw new AgentCredentialSessionRejectedError();
    }

    const revoked = await client.query<{ session_id: string }>(
      `UPDATE "agent_credential_sessions"
          SET "revoked_at" = $3,
              "revoked_reason" = $4
        WHERE "account_id" = $1
          AND "character_id" = $2
          AND "revoked_at" IS NULL
        RETURNING "session_id"`,
      [
        input.accountId,
        input.characterId,
        now,
        input.reason ?? "owner_revoked",
      ],
    );
    return revoked.rows.map((row) => row.session_id);
  });
}

function sessionMatchesClaims(
  row: AgentCredentialSessionRow | undefined,
  claims: NonNullable<ReturnType<typeof parseAgentCredentialClaims>>,
  now: Date,
): boolean {
  const expiresAt = row ? readTimestamp(row.expires_at) : null;
  return Boolean(
    row &&
    row.revoked_at === null &&
    row.account_id === claims.accountId &&
    row.character_id === claims.characterId &&
    row.auth_method === claims.authMethod &&
    expiresAt &&
    expiresAt.toISOString() === claims.expiresAt &&
    expiresAt.getTime() > now.getTime(),
  );
}

export async function verifyAgentCredentialSession(
  payload: Record<string, unknown>,
  authority: AgentCredentialQueryAuthority,
  nowInput?: Date,
): Promise<ReturnType<typeof parseAgentCredentialClaims>> {
  const claims = parseAgentCredentialClaims(payload);
  if (!claims) return null;
  const now = normalizeNow(nowInput);
  const result = await authority.query<AgentCredentialSessionRow>(
    `SELECT "session_id", "account_id", "character_id", "auth_method",
            "expires_at", "revoked_at"
       FROM "agent_credential_sessions"
      WHERE "session_id" = $1`,
    [claims.sessionId],
  );
  return sessionMatchesClaims(result.rows[0], claims, now) ? claims : null;
}

export async function verifyAgentCredentialSessionWithSystemDatabase(
  payload: Record<string, unknown>,
  db: SystemDatabase,
  nowInput?: Date,
): Promise<ReturnType<typeof parseAgentCredentialClaims>> {
  const claims = parseAgentCredentialClaims(payload);
  if (!claims) return null;
  const now = normalizeNow(nowInput);
  const row = (await db("agent_credential_sessions")
    .where("session_id", claims.sessionId)
    .first()) as AgentCredentialSessionRow | undefined;
  return sessionMatchesClaims(row, claims, now) ? claims : null;
}
