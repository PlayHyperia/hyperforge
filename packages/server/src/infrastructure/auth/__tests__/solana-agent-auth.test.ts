import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  canonicalizeSolanaWalletAddress,
  createSolanaAgentAuthChallengeMaterial,
  normalizeRequestedCharacterId,
  normalizeSolanaAgentName,
  readSolanaAgentAuthConfig,
  requestMatchesSolanaAgentAuthConfig,
  SolanaAgentAuthConfigurationError,
  SolanaAgentAuthInputError,
  verifySolanaAgentAuthSignature,
} from "../solana-agent-auth.js";

const configuredEnvironment = (): NodeJS.ProcessEnv => ({
  HYPERIA_SOL_AGENT_AUTH_CLUSTER: "devnet",
  HYPERIA_SOL_AGENT_AUTH_DOMAIN: "api.hyperia.test",
  HYPERIA_SOL_AGENT_AUTH_ENABLED: "true",
  HYPERIA_SOL_AGENT_AUTH_ORIGIN: "https://hyperia.test",
  HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS: "120",
});

describe("SOL agent authentication primitives", () => {
  it("stays disabled unless explicitly enabled and rejects incomplete configuration", () => {
    expect(readSolanaAgentAuthConfig({})).toBeNull();
    expect(() =>
      readSolanaAgentAuthConfig({
        HYPERIA_SOL_AGENT_AUTH_ENABLED: "true",
      }),
    ).toThrow(SolanaAgentAuthConfigurationError);
    expect(() =>
      readSolanaAgentAuthConfig({
        ...configuredEnvironment(),
        HYPERIA_SOL_AGENT_AUTH_ORIGIN: "http://hyperia.test",
      }),
    ).toThrow(/HTTPS/u);
    expect(() =>
      readSolanaAgentAuthConfig({
        ...configuredEnvironment(),
        HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS: "301",
      }),
    ).toThrow(/between 30 and 300/u);
    expect(() =>
      readSolanaAgentAuthConfig({
        ...configuredEnvironment(),
        HYPERIA_SOL_AGENT_AUTH_DOMAIN: "api.hyperia.test:99999",
      }),
    ).toThrow(SolanaAgentAuthConfigurationError);
  });

  it("accepts an exact production origin and a bounded exact loopback origin", () => {
    expect(readSolanaAgentAuthConfig(configuredEnvironment())).toMatchObject({
      cluster: "devnet",
      domain: "api.hyperia.test",
      origin: "https://hyperia.test",
      ttlSeconds: 120,
    });
    expect(
      readSolanaAgentAuthConfig({
        HYPERIA_SOL_AGENT_AUTH_CLUSTER: "localnet",
        HYPERIA_SOL_AGENT_AUTH_DOMAIN: "127.0.0.1:5555",
        HYPERIA_SOL_AGENT_AUTH_ENABLED: "true",
        HYPERIA_SOL_AGENT_AUTH_ORIGIN: "http://127.0.0.1:3333",
        HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS: "30",
      }),
    ).toMatchObject({
      cluster: "localnet",
      domain: "127.0.0.1:5555",
      origin: "http://127.0.0.1:3333",
    });
  });

  it("requires canonical SOL identities and bounded signed metadata", () => {
    const { publicKey } = ed25519.keygen();
    const walletAddress = bs58.encode(publicKey);
    expect(canonicalizeSolanaWalletAddress(walletAddress)).toBe(walletAddress);
    expect(() => canonicalizeSolanaWalletAddress("0x1234")).toThrow(
      SolanaAgentAuthInputError,
    );
    expect(normalizeSolanaAgentName(" Agent One ", walletAddress)).toBe(
      "Agent One",
    );
    expect(() => normalizeSolanaAgentName("bad\nname", walletAddress)).toThrow(
      SolanaAgentAuthInputError,
    );
    expect(normalizeRequestedCharacterId(undefined)).toBeNull();
    expect(normalizeRequestedCharacterId("character-1")).toBe("character-1");
    expect(() => normalizeRequestedCharacterId(" character-1")).toThrow(
      SolanaAgentAuthInputError,
    );
  });

  it("binds domain, origin, cluster, wallet, nonce, expiry, action, and requested character", () => {
    const config = readSolanaAgentAuthConfig(configuredEnvironment());
    expect(config).not.toBeNull();
    const { secretKey, publicKey } = ed25519.keygen();
    const walletAddress = bs58.encode(publicKey);
    const material = createSolanaAgentAuthChallengeMaterial({
      agentName: "Agent One",
      characterId: "character-1",
      config: config!,
      now: new Date("2026-08-27T12:00:00.000Z"),
      walletAddress,
    });
    expect(material.expiresAt.toISOString()).toBe("2026-08-27T12:02:00.000Z");
    expect(material.message).toContain("Domain: api.hyperia.test");
    expect(material.message).toContain("Origin: https://hyperia.test");
    expect(material.message).toContain("Solana Cluster: devnet");
    expect(material.message).toContain(`Wallet: ${walletAddress}`);
    expect(material.message).toContain("Character ID: character-1");
    expect(material.message).toContain(
      "This request authenticates an AI agent. It does not authorize a transaction.",
    );

    const signature = bs58.encode(
      ed25519.sign(new TextEncoder().encode(material.message), secretKey),
    );
    expect(
      verifySolanaAgentAuthSignature({
        message: material.message,
        signature,
        walletAddress,
      }),
    ).toBe(true);
    expect(
      verifySolanaAgentAuthSignature({
        message: `${material.message} `,
        signature,
        walletAddress,
      }),
    ).toBe(false);
    expect(
      verifySolanaAgentAuthSignature({
        message: material.message,
        signature: `${signature}1`,
        walletAddress,
      }),
    ).toBe(false);
  });

  it("requires the exact configured API host and rejects a mismatched browser origin", () => {
    const config = readSolanaAgentAuthConfig(configuredEnvironment());
    expect(config).not.toBeNull();
    expect(
      requestMatchesSolanaAgentAuthConfig(config!, {
        host: "api.hyperia.test",
        origin: "https://hyperia.test",
      }),
    ).toBe(true);
    expect(
      requestMatchesSolanaAgentAuthConfig(config!, {
        host: "api.hyperia.test",
      }),
    ).toBe(true);
    expect(
      requestMatchesSolanaAgentAuthConfig(config!, {
        host: "evil.test",
        origin: "https://hyperia.test",
      }),
    ).toBe(false);
    expect(
      requestMatchesSolanaAgentAuthConfig(config!, {
        host: "api.hyperia.test",
        origin: "https://evil.test",
      }),
    ).toBe(false);
  });
});
