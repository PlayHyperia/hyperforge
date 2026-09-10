import { describe, expect, it } from "vitest";
import {
  buildAgentCredentialJwtPayload,
  parseAgentCredentialClaims,
} from "../agent-credential-session.js";

const session = {
  accountId: "wallet:solana:account",
  authMethod: "sol-wallet-signature-v1" as const,
  characterId: "character-1",
  expiresAt: "2026-09-03T12:00:00.000Z",
  sessionId: "00000000-0000-4000-8000-000000000001",
};

describe("agent credential JWT claims", () => {
  it("builds and parses one exact versioned session binding", () => {
    const payload = buildAgentCredentialJwtPayload(session, {
      walletType: "solana",
    });
    expect(payload).toMatchObject({
      agentCredentialVersion: 1,
      agentSessionExpiresAt: session.expiresAt,
      agentSessionId: session.sessionId,
      authMethod: session.authMethod,
      characterId: session.characterId,
      isAgent: true,
      jti: session.sessionId,
      userId: session.accountId,
      walletType: "solana",
    });
    expect(parseAgentCredentialClaims(payload)).toEqual({
      accountId: session.accountId,
      authMethod: session.authMethod,
      characterId: session.characterId,
      expiresAt: session.expiresAt,
      sessionId: session.sessionId,
    });
  });

  it.each([
    ["missing version", { agentCredentialVersion: undefined }],
    ["wrong type", { isAgent: false }],
    ["mismatched jti", { jti: "00000000-0000-4000-8000-000000000002" }],
    ["invalid session", { agentSessionId: "not-a-session" }],
    ["unknown method", { authMethod: "wallet" }],
    ["noncanonical expiry", { agentSessionExpiresAt: "2026-09-03T12:00:00Z" }],
    ["empty account", { userId: "" }],
    ["empty character", { characterId: "" }],
  ])("rejects %s", (_name, mutation) => {
    expect(
      parseAgentCredentialClaims({
        ...buildAgentCredentialJwtPayload(session),
        ...mutation,
      }),
    ).toBeNull();
  });
});
