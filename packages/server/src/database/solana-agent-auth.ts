import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  createSolanaAgentAuthChallengeMaterial,
  hashSolanaAgentAuthMessage,
  hashSolanaWalletAddress,
  verifySolanaAgentAuthSignature,
  type SolanaAgentAuthConfig,
} from "../infrastructure/auth/solana-agent-auth.js";
import type { AgentCredentialSession } from "../infrastructure/auth/agent-credential-session.js";
import { rotateAgentCredentialSessionWithClient } from "./agent-credential-sessions.js";

const MAX_FAILED_ATTEMPTS = 5;
const MAX_CHALLENGES_PER_WALLET_PER_MINUTE = 5;

export interface SolanaAgentAuthPool {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
}

export interface IssuedSolanaAgentAuthChallenge {
  challengeId: string;
  expiresAt: string;
  message: string;
  signatureEncoding: "base58";
}

export interface VerifiedSolanaAgentIdentity {
  accountId: string;
  agentName: string;
  characterId: string;
  credentialSession: AgentCredentialSession;
  walletAddress: string;
}

type ChallengeRow = {
  agent_name: string;
  challenge_id: string;
  character_id: string | null;
  config_fingerprint: string;
  consumed_at: Date | string | null;
  expires_at: Date | string;
  failed_attempts: number;
  message_hash: string;
  revoked_at: Date | string | null;
  wallet_hash: string;
};

type CharacterRow = {
  id: string;
  isAgent: number | null;
  name: string;
  wallet: string | null;
};

export class SolanaAgentAuthRejectedError extends Error {
  constructor() {
    super("Wallet authentication failed");
    this.name = "SolanaAgentAuthRejectedError";
  }
}

export class SolanaAgentAuthRateLimitError extends Error {
  constructor() {
    super("Wallet authentication challenge rate limit exceeded");
    this.name = "SolanaAgentAuthRateLimitError";
  }
}

export class SolanaAgentAuthProvisioningError extends Error {
  readonly code: "ambiguous_characters" | "character_not_available";

  constructor(
    code: "ambiguous_characters" | "character_not_available",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "SolanaAgentAuthProvisioningError";
  }
}

async function withTransaction<T>(
  pool: SolanaAgentAuthPool,
  callback: (client: Pick<PoolClient, "query">) => Promise<T>,
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
      // Preserve the original transaction failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function issueSolanaAgentAuthChallenge(input: {
  agentName: string;
  characterId: string | null;
  config: SolanaAgentAuthConfig;
  now?: Date;
  pool: SolanaAgentAuthPool;
  walletAddress: string;
}): Promise<IssuedSolanaAgentAuthChallenge> {
  const material = createSolanaAgentAuthChallengeMaterial(input);
  const walletHash = hashSolanaWalletAddress(input.walletAddress);

  await withTransaction(input.pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`solana-agent-auth:${walletHash}`],
    );

    const recent = await client.query<{ challenge_count: string }>(
      `SELECT COUNT(*)::text AS challenge_count
         FROM "solana_agent_auth_challenges"
        WHERE "wallet_hash" = $1
          AND "issued_at" >= $2::timestamptz - INTERVAL '1 minute'`,
      [walletHash, material.issuedAt],
    );
    if (
      Number(recent.rows[0]?.challenge_count ?? 0) >=
      MAX_CHALLENGES_PER_WALLET_PER_MINUTE
    ) {
      throw new SolanaAgentAuthRateLimitError();
    }

    await client.query(
      `UPDATE "solana_agent_auth_challenges"
          SET "revoked_at" = $2,
              "failure_code" = 'superseded'
        WHERE "wallet_hash" = $1
          AND "consumed_at" IS NULL
          AND "revoked_at" IS NULL
          AND "expires_at" > $2`,
      [walletHash, material.issuedAt],
    );

    await client.query(
      `INSERT INTO "solana_agent_auth_challenges" (
         "challenge_id",
         "wallet_hash",
         "message_hash",
         "nonce_hash",
         "config_fingerprint",
         "agent_name",
         "character_id",
         "issued_at",
         "expires_at"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        material.challengeId,
        walletHash,
        material.messageHash,
        material.nonceHash,
        input.config.fingerprint,
        input.agentName,
        input.characterId,
        material.issuedAt,
        material.expiresAt,
      ],
    );
  });

  return {
    challengeId: material.challengeId,
    expiresAt: material.expiresAt.toISOString(),
    message: material.message,
    signatureEncoding: "base58",
  };
}

async function rejectChallengeAttempt(
  client: Pick<PoolClient, "query">,
  challengeId: string,
  failedAttempts: number,
  failureCode:
    | "config_changed"
    | "expired"
    | "invalid_message"
    | "invalid_signature"
    | "invalid_wallet",
  now: Date,
): Promise<void> {
  const nextAttempts = Math.min(failedAttempts + 1, MAX_FAILED_ATTEMPTS);
  const revoke =
    failureCode === "config_changed" ||
    failureCode === "expired" ||
    nextAttempts >= MAX_FAILED_ATTEMPTS;
  await client.query(
    `UPDATE "solana_agent_auth_challenges"
        SET "failed_attempts" = $2,
            "last_failure_at" = $3,
            "failure_code" = $4,
            "revoked_at" = CASE WHEN $5 THEN $3 ELSE "revoked_at" END
      WHERE "challenge_id" = $1`,
    [challengeId, nextAttempts, now, failureCode, revoke],
  );
}

async function provisionVerifiedSolanaAgent(
  client: Pick<PoolClient, "query">,
  input: {
    agentName: string;
    characterId: string | null;
    walletAddress: string;
  },
): Promise<Omit<VerifiedSolanaAgentIdentity, "credentialSession">> {
  const accountId = `wallet:solana:${input.walletAddress}`;
  const now = new Date();

  await client.query(
    `INSERT INTO "users" ("id", "name", "roles", "createdAt", "wallet")
     VALUES ($1, $2, 'player', $3, $4)
     ON CONFLICT ("id") DO NOTHING`,
    [accountId, input.agentName, now.toISOString(), input.walletAddress],
  );
  const userResult = await client.query<{ wallet: string | null }>(
    `SELECT "wallet"
       FROM "users"
      WHERE "id" = $1
      FOR UPDATE`,
    [accountId],
  );
  const user = userResult.rows[0];
  if (!user || (user.wallet !== null && user.wallet !== input.walletAddress)) {
    throw new SolanaAgentAuthRejectedError();
  }
  if (user.wallet === null) {
    await client.query(
      `UPDATE "users" SET "wallet" = $2 WHERE "id" = $1 AND "wallet" IS NULL`,
      [accountId, input.walletAddress],
    );
  }

  let character: CharacterRow | undefined;
  if (input.characterId) {
    const selected = await client.query<CharacterRow>(
      `SELECT "id", "name", "wallet", "isAgent"
         FROM "characters"
        WHERE "id" = $1 AND "accountId" = $2
        FOR UPDATE`,
      [input.characterId, accountId],
    );
    character = selected.rows[0];
    if (!character) {
      throw new SolanaAgentAuthProvisioningError(
        "character_not_available",
        "The requested agent character is not available for this wallet",
      );
    }
  } else {
    const existing = await client.query<CharacterRow>(
      `SELECT "id", "name", "wallet", "isAgent"
         FROM "characters"
        WHERE "accountId" = $1
        ORDER BY "createdAt" ASC NULLS LAST, "id" ASC
        LIMIT 2
        FOR UPDATE`,
      [accountId],
    );
    if (existing.rows.length > 1) {
      throw new SolanaAgentAuthProvisioningError(
        "ambiguous_characters",
        "characterId is required when a wallet owns multiple characters",
      );
    }
    character = existing.rows[0];
  }

  if (!character) {
    const characterId = randomUUID();
    const inserted = await client.query<CharacterRow>(
      `INSERT INTO "characters" (
         "id", "accountId", "name", "wallet", "isAgent", "createdAt"
       ) VALUES ($1, $2, $3, $4, 1, $5)
       RETURNING "id", "name", "wallet", "isAgent"`,
      [
        characterId,
        accountId,
        input.agentName,
        input.walletAddress,
        now.getTime(),
      ],
    );
    character = inserted.rows[0];
  }

  if (
    !character ||
    character.isAgent !== 1 ||
    (character.wallet !== null && character.wallet !== input.walletAddress)
  ) {
    throw new SolanaAgentAuthProvisioningError(
      "character_not_available",
      "The selected character is not an agent character for this wallet",
    );
  }
  if (character.wallet === null) {
    await client.query(
      `UPDATE "characters"
          SET "wallet" = $2
        WHERE "id" = $1 AND "wallet" IS NULL`,
      [character.id, input.walletAddress],
    );
  }

  return {
    accountId,
    agentName: character.name,
    characterId: character.id,
    walletAddress: input.walletAddress,
  };
}

export async function verifyAndConsumeSolanaAgentAuthChallenge(input: {
  challengeId: string;
  config: SolanaAgentAuthConfig;
  message: string;
  now?: Date;
  pool: SolanaAgentAuthPool;
  signature: unknown;
  walletAddress: string;
}): Promise<VerifiedSolanaAgentIdentity> {
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new SolanaAgentAuthRejectedError();
  }

  const outcome = await withTransaction<
    { identity: VerifiedSolanaAgentIdentity; ok: true } | { ok: false }
  >(input.pool, async (client) => {
    const challengeResult = await client.query<ChallengeRow>(
      `SELECT "challenge_id", "wallet_hash", "message_hash",
              "config_fingerprint", "agent_name", "character_id",
              "expires_at", "consumed_at", "revoked_at", "failed_attempts"
         FROM "solana_agent_auth_challenges"
        WHERE "challenge_id" = $1
        FOR UPDATE`,
      [input.challengeId],
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.consumed_at || challenge.revoked_at) {
      throw new SolanaAgentAuthRejectedError();
    }

    const expiresAt = new Date(challenge.expires_at);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime()
    ) {
      await rejectChallengeAttempt(
        client,
        challenge.challenge_id,
        challenge.failed_attempts,
        "expired",
        now,
      );
      return { ok: false };
    }
    if (challenge.config_fingerprint !== input.config.fingerprint) {
      await rejectChallengeAttempt(
        client,
        challenge.challenge_id,
        challenge.failed_attempts,
        "config_changed",
        now,
      );
      return { ok: false };
    }
    if (
      challenge.wallet_hash !== hashSolanaWalletAddress(input.walletAddress)
    ) {
      await rejectChallengeAttempt(
        client,
        challenge.challenge_id,
        challenge.failed_attempts,
        "invalid_wallet",
        now,
      );
      return { ok: false };
    }
    if (
      typeof input.message !== "string" ||
      input.message.length > 4096 ||
      challenge.message_hash !== hashSolanaAgentAuthMessage(input.message)
    ) {
      await rejectChallengeAttempt(
        client,
        challenge.challenge_id,
        challenge.failed_attempts,
        "invalid_message",
        now,
      );
      return { ok: false };
    }
    if (
      !verifySolanaAgentAuthSignature({
        message: input.message,
        signature: input.signature,
        walletAddress: input.walletAddress,
      })
    ) {
      await rejectChallengeAttempt(
        client,
        challenge.challenge_id,
        challenge.failed_attempts,
        "invalid_signature",
        now,
      );
      return { ok: false };
    }

    const provisionedIdentity = await provisionVerifiedSolanaAgent(client, {
      agentName: challenge.agent_name,
      characterId: challenge.character_id,
      walletAddress: input.walletAddress,
    });
    const credentialSession = await rotateAgentCredentialSessionWithClient(
      client,
      {
        accountId: provisionedIdentity.accountId,
        authMethod: "sol-wallet-signature-v1",
        characterId: provisionedIdentity.characterId,
        now,
      },
    );
    const consumed = await client.query(
      `UPDATE "solana_agent_auth_challenges"
          SET "consumed_at" = $2,
              "failure_code" = NULL
        WHERE "challenge_id" = $1
          AND "consumed_at" IS NULL
          AND "revoked_at" IS NULL`,
      [challenge.challenge_id, now],
    );
    if (consumed.rowCount !== 1) {
      throw new SolanaAgentAuthRejectedError();
    }
    return {
      identity: { ...provisionedIdentity, credentialSession },
      ok: true,
    };
  });

  if (!outcome.ok) {
    throw new SolanaAgentAuthRejectedError();
  }
  return outcome.identity;
}
