import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  issueSolanaAgentAuthChallenge,
  SolanaAgentAuthRateLimitError,
  SolanaAgentAuthRejectedError,
  verifyAndConsumeSolanaAgentAuthChallenge,
} from "../solana-agent-auth.js";
import {
  hashSolanaWalletAddress,
  readSolanaAgentAuthConfig,
} from "../../infrastructure/auth/solana-agent-auth.js";

const connectionString = process.env.SOLANA_AGENT_AUTH_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const config = readSolanaAgentAuthConfig({
  HYPERIA_SOL_AGENT_AUTH_CLUSTER: "localnet",
  HYPERIA_SOL_AGENT_AUTH_DOMAIN: "127.0.0.1:5555",
  HYPERIA_SOL_AGENT_AUTH_ENABLED: "true",
  HYPERIA_SOL_AGENT_AUTH_ORIGIN: "http://127.0.0.1:3333",
  HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS: "120",
})!;

const signMessage = (message: string, secretKey: Uint8Array): string =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(message), secretKey));

describeWithDatabase("SOL agent authentication PostgreSQL authority", () => {
  const pool = new pg.Pool({ connectionString, max: 8 });
  const walletHashes = new Set<string>();
  const accountIds = new Set<string>();
  const fixedNow = new Date("2026-08-27T12:00:00.000Z");

  const createWallet = () => {
    const keypair = ed25519.keygen();
    const walletAddress = bs58.encode(keypair.publicKey);
    walletHashes.add(hashSolanaWalletAddress(walletAddress));
    accountIds.add(`wallet:solana:${walletAddress}`);
    return { ...keypair, walletAddress };
  };

  afterAll(async () => {
    if (walletHashes.size > 0) {
      await pool.query(
        `DELETE FROM "solana_agent_auth_challenges"
          WHERE "wallet_hash" = ANY($1::text[])`,
        [[...walletHashes]],
      );
    }
    if (accountIds.size > 0) {
      await pool.query(`DELETE FROM "users" WHERE "id" = ANY($1::text[])`, [
        [...accountIds],
      ]);
    }
    await pool.end();
  });

  it("atomically provisions one SOL agent identity and consumes the signed challenge once", async () => {
    const wallet = createWallet();
    const challenge = await issueSolanaAgentAuthChallenge({
      agentName: "Atomic Agent",
      characterId: null,
      config,
      now: fixedNow,
      pool,
      walletAddress: wallet.walletAddress,
    });
    const signature = signMessage(challenge.message, wallet.secretKey);
    const identity = await verifyAndConsumeSolanaAgentAuthChallenge({
      challengeId: challenge.challengeId,
      config,
      message: challenge.message,
      now: new Date(fixedNow.getTime() + 1_000),
      pool,
      signature,
      walletAddress: wallet.walletAddress,
    });

    expect(identity).toMatchObject({
      accountId: `wallet:solana:${wallet.walletAddress}`,
      agentName: "Atomic Agent",
      walletAddress: wallet.walletAddress,
    });
    await expect(
      verifyAndConsumeSolanaAgentAuthChallenge({
        challengeId: challenge.challengeId,
        config,
        message: challenge.message,
        now: new Date(fixedNow.getTime() + 2_000),
        pool,
        signature,
        walletAddress: wallet.walletAddress,
      }),
    ).rejects.toBeInstanceOf(SolanaAgentAuthRejectedError);

    const persisted = await pool.query<{
      consumed_at: Date | null;
      isAgent: number;
      wallet: string;
    }>(
      `SELECT c."consumed_at", character."isAgent", character."wallet"
         FROM "solana_agent_auth_challenges" c
         JOIN "characters" character ON character."id" = $2
        WHERE c."challenge_id" = $1`,
      [challenge.challengeId, identity.characterId],
    );
    expect(persisted.rows[0]).toMatchObject({
      isAgent: 1,
      wallet: wallet.walletAddress,
    });
    expect(persisted.rows[0]?.consumed_at).not.toBeNull();
  });

  it("allows exactly one winner when the same proof is submitted concurrently", async () => {
    const wallet = createWallet();
    const challenge = await issueSolanaAgentAuthChallenge({
      agentName: "Concurrent Agent",
      characterId: null,
      config,
      now: fixedNow,
      pool,
      walletAddress: wallet.walletAddress,
    });
    const signature = signMessage(challenge.message, wallet.secretKey);
    const attempts = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        verifyAndConsumeSolanaAgentAuthChallenge({
          challengeId: challenge.challengeId,
          config,
          message: challenge.message,
          now: new Date(fixedNow.getTime() + 1_000),
          pool,
          signature,
          walletAddress: wallet.walletAddress,
        }),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
  });

  it("durably counts invalid proofs and revokes the challenge on the fifth failure", async () => {
    const wallet = createWallet();
    const attacker = ed25519.keygen();
    const challenge = await issueSolanaAgentAuthChallenge({
      agentName: "Attempt Agent",
      characterId: null,
      config,
      now: fixedNow,
      pool,
      walletAddress: wallet.walletAddress,
    });
    const invalidSignature = signMessage(challenge.message, attacker.secretKey);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        verifyAndConsumeSolanaAgentAuthChallenge({
          challengeId: challenge.challengeId,
          config,
          message: challenge.message,
          now: new Date(fixedNow.getTime() + 1_000 + attempt),
          pool,
          signature: invalidSignature,
          walletAddress: wallet.walletAddress,
        }),
      ).rejects.toBeInstanceOf(SolanaAgentAuthRejectedError);
    }

    const persisted = await pool.query<{
      failed_attempts: number;
      failure_code: string;
      revoked_at: Date | null;
    }>(
      `SELECT "failed_attempts", "failure_code", "revoked_at"
         FROM "solana_agent_auth_challenges"
        WHERE "challenge_id" = $1`,
      [challenge.challengeId],
    );
    expect(persisted.rows[0]).toMatchObject({
      failed_attempts: 5,
      failure_code: "invalid_signature",
    });
    expect(persisted.rows[0]?.revoked_at).not.toBeNull();
  });

  it("supersedes earlier outstanding proofs and enforces the per-wallet issuance bound", async () => {
    const wallet = createWallet();
    const challenges = [];
    for (let index = 0; index < 5; index += 1) {
      challenges.push(
        await issueSolanaAgentAuthChallenge({
          agentName: "Bounded Agent",
          characterId: null,
          config,
          now: new Date(fixedNow.getTime() + index),
          pool,
          walletAddress: wallet.walletAddress,
        }),
      );
    }
    await expect(
      issueSolanaAgentAuthChallenge({
        agentName: "Bounded Agent",
        characterId: null,
        config,
        now: new Date(fixedNow.getTime() + 5),
        pool,
        walletAddress: wallet.walletAddress,
      }),
    ).rejects.toBeInstanceOf(SolanaAgentAuthRateLimitError);

    const first = challenges[0]!;
    await expect(
      verifyAndConsumeSolanaAgentAuthChallenge({
        challengeId: first.challengeId,
        config,
        message: first.message,
        now: new Date(fixedNow.getTime() + 1_000),
        pool,
        signature: signMessage(first.message, wallet.secretKey),
        walletAddress: wallet.walletAddress,
      }),
    ).rejects.toBeInstanceOf(SolanaAgentAuthRejectedError);
  });

  it("stores only hashes for the wallet, message, nonce, and signature evidence", async () => {
    const wallet = createWallet();
    const challenge = await issueSolanaAgentAuthChallenge({
      agentName: "Private Evidence Agent",
      characterId: null,
      config,
      now: fixedNow,
      pool,
      walletAddress: wallet.walletAddress,
    });
    const signature = signMessage(challenge.message, wallet.secretKey);
    const persisted = await pool.query<{ evidence: string }>(
      `SELECT to_jsonb(c)::text AS evidence
         FROM "solana_agent_auth_challenges" c
        WHERE "challenge_id" = $1`,
      [challenge.challengeId],
    );
    const evidence = persisted.rows[0]?.evidence ?? "";
    expect(evidence).not.toContain(wallet.walletAddress);
    expect(evidence).not.toContain(challenge.message);
    expect(evidence).not.toContain(signature);
    expect(evidence).toContain(hashSolanaWalletAddress(wallet.walletAddress));

    await expect(
      pool.query(
        `UPDATE "solana_agent_auth_challenges"
            SET "message_hash" = $2
          WHERE "challenge_id" = $1`,
        [challenge.challengeId, "00".repeat(32)],
      ),
    ).rejects.toThrow(/authority fields are immutable/u);
  });

  it("fails closed on ambiguous character ownership and accepts an exact signed character selection", async () => {
    const wallet = createWallet();
    const initial = await issueSolanaAgentAuthChallenge({
      agentName: "Character Agent",
      characterId: null,
      config,
      now: fixedNow,
      pool,
      walletAddress: wallet.walletAddress,
    });
    const identity = await verifyAndConsumeSolanaAgentAuthChallenge({
      challengeId: initial.challengeId,
      config,
      message: initial.message,
      now: new Date(fixedNow.getTime() + 1_000),
      pool,
      signature: signMessage(initial.message, wallet.secretKey),
      walletAddress: wallet.walletAddress,
    });
    await pool.query(
      `INSERT INTO "characters" (
         "id", "accountId", "name", "wallet", "isAgent", "createdAt"
       ) VALUES ($1, $2, 'Second Agent', $3, 1, $4)`,
      [
        `second-${identity.characterId}`,
        identity.accountId,
        wallet.walletAddress,
        fixedNow.getTime() + 2_000,
      ],
    );

    const ambiguous = await issueSolanaAgentAuthChallenge({
      agentName: "Character Agent",
      characterId: null,
      config,
      now: new Date(fixedNow.getTime() + 3_000),
      pool,
      walletAddress: wallet.walletAddress,
    });
    await expect(
      verifyAndConsumeSolanaAgentAuthChallenge({
        challengeId: ambiguous.challengeId,
        config,
        message: ambiguous.message,
        now: new Date(fixedNow.getTime() + 4_000),
        pool,
        signature: signMessage(ambiguous.message, wallet.secretKey),
        walletAddress: wallet.walletAddress,
      }),
    ).rejects.toMatchObject({
      code: "ambiguous_characters",
    });
    const ambiguousState = await pool.query<{ consumed_at: Date | null }>(
      `SELECT "consumed_at"
         FROM "solana_agent_auth_challenges"
        WHERE "challenge_id" = $1`,
      [ambiguous.challengeId],
    );
    expect(ambiguousState.rows[0]?.consumed_at).toBeNull();

    const exact = await issueSolanaAgentAuthChallenge({
      agentName: "Character Agent",
      characterId: identity.characterId,
      config,
      now: new Date(fixedNow.getTime() + 5_000),
      pool,
      walletAddress: wallet.walletAddress,
    });
    await expect(
      verifyAndConsumeSolanaAgentAuthChallenge({
        challengeId: exact.challengeId,
        config,
        message: exact.message,
        now: new Date(fixedNow.getTime() + 6_000),
        pool,
        signature: signMessage(exact.message, wallet.secretKey),
        walletAddress: wallet.walletAddress,
      }),
    ).resolves.toMatchObject({ characterId: identity.characterId });
  });
});
