import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const AUTH_VERSION = "1";
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;
const DOMAIN_HOSTNAME_PATTERN =
  /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)$/u;
const AGENT_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,48}$/u;
const SOLANA_CLUSTERS = new Set([
  "mainnet-beta",
  "devnet",
  "testnet",
  "localnet",
]);

export interface SolanaAgentAuthConfig {
  cluster: "mainnet-beta" | "devnet" | "testnet" | "localnet";
  domain: string;
  fingerprint: string;
  origin: string;
  ttlSeconds: number;
}

export interface SolanaAgentAuthChallengeMaterial {
  challengeId: string;
  expiresAt: Date;
  issuedAt: Date;
  message: string;
  messageHash: string;
  nonce: string;
  nonceHash: string;
}

export class SolanaAgentAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaAgentAuthConfigurationError";
  }
}

export class SolanaAgentAuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaAgentAuthInputError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function requireConfiguredValue(
  environment: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new SolanaAgentAuthConfigurationError(
      `${key} is required when SOL agent authentication is enabled`,
    );
  }
  return value;
}

export function readSolanaAgentAuthConfig(
  environment: NodeJS.ProcessEnv,
): SolanaAgentAuthConfig | null {
  if (environment.HYPERIA_SOL_AGENT_AUTH_ENABLED?.trim() !== "true") {
    return null;
  }

  const domain = requireConfiguredValue(
    environment,
    "HYPERIA_SOL_AGENT_AUTH_DOMAIN",
  ).toLowerCase();
  let domainUrl: URL;
  try {
    domainUrl = new URL(`https://${domain}`);
  } catch {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_DOMAIN must be one exact lowercase DNS/loopback host with an optional port",
    );
  }
  if (
    domainUrl.host !== domain ||
    !DOMAIN_HOSTNAME_PATTERN.test(domainUrl.hostname)
  ) {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_DOMAIN must be one exact lowercase DNS/loopback host with an optional port",
    );
  }

  const rawOrigin = requireConfiguredValue(
    environment,
    "HYPERIA_SOL_AGENT_AUTH_ORIGIN",
  );
  let originUrl: URL;
  try {
    originUrl = new URL(rawOrigin);
  } catch {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_ORIGIN must be an absolute origin URL",
    );
  }
  if (
    originUrl.origin !== rawOrigin ||
    originUrl.username !== "" ||
    originUrl.password !== ""
  ) {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_ORIGIN must contain only scheme, host, and optional port",
    );
  }
  if (
    originUrl.protocol !== "https:" &&
    !(originUrl.protocol === "http:" && isLoopbackHostname(originUrl.hostname))
  ) {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_ORIGIN must use HTTPS except on exact loopback hosts",
    );
  }

  const cluster = requireConfiguredValue(
    environment,
    "HYPERIA_SOL_AGENT_AUTH_CLUSTER",
  );
  if (!SOLANA_CLUSTERS.has(cluster)) {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_CLUSTER must be mainnet-beta, devnet, testnet, or localnet",
    );
  }

  const rawTtl = requireConfiguredValue(
    environment,
    "HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS",
  );
  if (!/^[1-9][0-9]*$/u.test(rawTtl)) {
    throw new SolanaAgentAuthConfigurationError(
      "HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS must be a whole number",
    );
  }
  const ttlSeconds = Number(rawTtl);
  if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new SolanaAgentAuthConfigurationError(
      `HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
    );
  }

  const normalizedCluster = cluster as SolanaAgentAuthConfig["cluster"];
  const origin = originUrl.origin;
  const fingerprint = sha256(
    JSON.stringify({
      cluster: normalizedCluster,
      domain,
      origin,
      ttlSeconds,
      version: AUTH_VERSION,
    }),
  );

  return {
    cluster: normalizedCluster,
    domain,
    fingerprint,
    origin,
    ttlSeconds,
  };
}

export function canonicalizeSolanaWalletAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new SolanaAgentAuthInputError(
      "walletAddress must be a canonical base58 Solana address",
    );
  }
  const trimmed = value.trim();
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch {
    throw new SolanaAgentAuthInputError(
      "walletAddress must be a canonical base58 Solana address",
    );
  }
  if (decoded.length !== 32 || bs58.encode(decoded) !== trimmed) {
    throw new SolanaAgentAuthInputError(
      "walletAddress must be a canonical base58 Solana address",
    );
  }
  return trimmed;
}

export function normalizeSolanaAgentName(
  value: unknown,
  walletAddress: string,
): string {
  const normalized =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : `Agent ${walletAddress.slice(0, 8)}`;
  if (!AGENT_NAME_PATTERN.test(normalized)) {
    throw new SolanaAgentAuthInputError(
      "agentName must contain 1-48 printable characters without control characters",
    );
  }
  return normalized;
}

export function normalizeRequestedCharacterId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SolanaAgentAuthInputError(
      "characterId must be a valid exact character identifier",
    );
  }
  return value;
}

export function hashSolanaWalletAddress(walletAddress: string): string {
  return sha256(walletAddress);
}

export function createSolanaAgentAuthChallengeMaterial(input: {
  agentName: string;
  characterId: string | null;
  config: SolanaAgentAuthConfig;
  now?: Date;
  walletAddress: string;
}): SolanaAgentAuthChallengeMaterial {
  const issuedAt = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(issuedAt.getTime())) {
    throw new Error("Challenge issuance time is invalid");
  }
  const expiresAt = new Date(
    issuedAt.getTime() + input.config.ttlSeconds * 1000,
  );
  const challengeId = randomUUID();
  const nonce = bs58.encode(randomBytes(32));
  const verificationUri = new URL(
    "/api/agents/sol-wallet-auth/verify",
    input.config.origin,
  ).toString();
  const message = [
    "Hyperia Agent Authentication",
    "",
    "This request authenticates an AI agent. It does not authorize a transaction.",
    "",
    `Domain: ${input.config.domain}`,
    `Origin: ${input.config.origin}`,
    `URI: ${verificationUri}`,
    `Solana Cluster: ${input.config.cluster}`,
    `Wallet: ${input.walletAddress}`,
    `Challenge ID: ${challengeId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
    "Action: authenticate-agent",
    `Agent Name: ${input.agentName}`,
    `Character ID: ${input.characterId ?? "new-or-only-agent-character"}`,
    `Version: ${AUTH_VERSION}`,
  ].join("\n");

  return {
    challengeId,
    expiresAt,
    issuedAt,
    message,
    messageHash: sha256(message),
    nonce,
    nonceHash: sha256(nonce),
  };
}

export function hashSolanaAgentAuthMessage(message: string): string {
  return sha256(message);
}

export function verifySolanaAgentAuthSignature(input: {
  message: string;
  signature: unknown;
  walletAddress: string;
}): boolean {
  if (
    typeof input.signature !== "string" ||
    input.signature.trim() !== input.signature
  ) {
    return false;
  }

  try {
    const signature = bs58.decode(input.signature);
    const publicKey = bs58.decode(input.walletAddress);
    if (
      signature.length !== 64 ||
      bs58.encode(signature) !== input.signature ||
      publicKey.length !== 32
    ) {
      return false;
    }
    return ed25519.verify(
      signature,
      new TextEncoder().encode(input.message),
      publicKey,
      { zip215: false },
    );
  } catch {
    return false;
  }
}

export function requestMatchesSolanaAgentAuthConfig(
  config: SolanaAgentAuthConfig,
  headers: Record<string, unknown>,
): boolean {
  const rawHost = headers.host;
  const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  if (typeof host !== "string" || host.trim().toLowerCase() !== config.domain) {
    return false;
  }

  const rawOrigin = headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  return origin === undefined || origin === config.origin;
}
