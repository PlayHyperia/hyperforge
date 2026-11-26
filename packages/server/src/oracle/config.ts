import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  DuelArenaOracleConfig,
  DuelArenaOracleProfile,
  DuelArenaOracleSolanaTargetConfig,
} from "./types.js";

function normalizeProfile(value: string | undefined): DuelArenaOracleProfile {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "testnet";
  if (normalized === "local") return "local";
  if (normalized === "testnet") return "testnet";
  if (normalized === "mainnet") return "mainnet";
  if (normalized === "all") return "all";
  throw new Error(
    `DUEL_ARENA_ORACLE_PROFILE must be local, testnet, mainnet, or all; received ${value}`,
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readFirstEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveMetadataBaseUrl(): string {
  const configured = process.env.DUEL_ARENA_ORACLE_METADATA_BASE_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }

  const explicitApiUrl = process.env.PUBLIC_API_URL?.trim();
  if (explicitApiUrl) {
    return `${trimTrailingSlash(explicitApiUrl)}/api/duel-arena/oracle`;
  }

  const protocol =
    (process.env.SERVER_PROTOCOL || "http").replace(/:$/, "").trim() || "http";
  const host = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  const port = process.env.PORT?.trim() || "5555";
  return `${protocol}://${host}:${port}/api/duel-arena/oracle`;
}

function resolveStorePath(): string {
  const configured = process.env.DUEL_ARENA_ORACLE_STORE_PATH?.trim();
  if (configured) {
    return configured;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  return path.resolve(currentDir, "../../data/duel-arena-oracle/records.json");
}

function buildSolanaTarget(
  key: DuelArenaOracleSolanaTargetConfig["key"],
  label: string,
  rpcUrlEnv: string,
  fallbackRpcUrl: string,
  wsUrlEnv: string,
  fallbackWsUrl: string,
  programIdEnv: string,
  fallbackProgramId: string,
  authoritySecretEnv: string,
  reporterSecretEnv: string,
  fallbackAuthoritySecretEnvs: string[] = [],
  fallbackReporterSecretEnvs: string[] = [],
): DuelArenaOracleSolanaTargetConfig | null {
  const reporterSecret =
    readFirstEnvValue(reporterSecretEnv, ...fallbackReporterSecretEnvs) || null;
  const authoritySecret =
    readFirstEnvValue(authoritySecretEnv, ...fallbackAuthoritySecretEnvs) ||
    null;
  const programId = process.env[programIdEnv]?.trim() || fallbackProgramId;

  if (!reporterSecret && !authoritySecret) {
    return null;
  }

  return {
    key,
    label,
    rpcUrl: process.env[rpcUrlEnv]?.trim() || fallbackRpcUrl,
    wsUrl: process.env[wsUrlEnv]?.trim() || fallbackWsUrl,
    programId,
    authoritySecret,
    reporterSecret,
  };
}

export function getDuelArenaOracleConfig(): DuelArenaOracleConfig {
  const enabled = process.env.DUEL_ARENA_ORACLE_ENABLED === "true";
  const profile = normalizeProfile(process.env.DUEL_ARENA_ORACLE_PROFILE);
  const rawDelay = process.env.ORACLE_SETTLEMENT_DELAY_MS?.trim();
  if (rawDelay && !/^\d+$/.test(rawDelay)) {
    throw new Error(
      "ORACLE_SETTLEMENT_DELAY_MS must be a non-negative integer",
    );
  }
  const settlementDelayMs = rawDelay ? Number(rawDelay) : 7000;
  if (!Number.isSafeInteger(settlementDelayMs)) {
    throw new Error(
      "ORACLE_SETTLEMENT_DELAY_MS must be a non-negative safe integer",
    );
  }
  const solanaTargets: DuelArenaOracleSolanaTargetConfig[] = [];

  if (profile === "local" || profile === "all") {
    const localnetTarget = buildSolanaTarget(
      "solanaLocalnet",
      "Solana Localnet",
      "DUEL_ARENA_ORACLE_SOLANA_LOCALNET_RPC_URL",
      "http://127.0.0.1:8899",
      "DUEL_ARENA_ORACLE_SOLANA_LOCALNET_WS_URL",
      "ws://127.0.0.1:8900",
      "DUEL_ARENA_ORACLE_SOLANA_LOCALNET_PROGRAM_ID",
      "6Tx7s2UG4maFWakRFVi4GeecXJYyBXQF8f2vJdQShSpV",
      "DUEL_ARENA_ORACLE_SOLANA_LOCALNET_AUTHORITY_SECRET",
      "DUEL_ARENA_ORACLE_SOLANA_LOCALNET_REPORTER_SECRET",
      ["DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET"],
      ["DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET"],
    );
    if (localnetTarget) {
      solanaTargets.push(localnetTarget);
    }
  }

  if (profile === "testnet" || profile === "all") {
    const devnetTarget = buildSolanaTarget(
      "solanaDevnet",
      "Solana Devnet",
      "DUEL_ARENA_ORACLE_SOLANA_DEVNET_RPC_URL",
      "https://api.devnet.solana.com",
      "DUEL_ARENA_ORACLE_SOLANA_DEVNET_WS_URL",
      "wss://api.devnet.solana.com/",
      "DUEL_ARENA_ORACLE_SOLANA_DEVNET_PROGRAM_ID",
      "6Tx7s2UG4maFWakRFVi4GeecXJYyBXQF8f2vJdQShSpV",
      "DUEL_ARENA_ORACLE_SOLANA_DEVNET_AUTHORITY_SECRET",
      "DUEL_ARENA_ORACLE_SOLANA_DEVNET_REPORTER_SECRET",
      ["DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET"],
      ["DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET"],
    );
    if (devnetTarget) {
      solanaTargets.push(devnetTarget);
    }
  }

  if (profile === "mainnet" || profile === "all") {
    const mainnetTarget = buildSolanaTarget(
      "solanaMainnet",
      "Solana Mainnet",
      "DUEL_ARENA_ORACLE_SOLANA_MAINNET_RPC_URL",
      "https://api.mainnet-beta.solana.com",
      "DUEL_ARENA_ORACLE_SOLANA_MAINNET_WS_URL",
      "wss://api.mainnet-beta.solana.com/",
      "DUEL_ARENA_ORACLE_SOLANA_MAINNET_PROGRAM_ID",
      "6Tx7s2UG4maFWakRFVi4GeecXJYyBXQF8f2vJdQShSpV",
      "DUEL_ARENA_ORACLE_SOLANA_MAINNET_AUTHORITY_SECRET",
      "DUEL_ARENA_ORACLE_SOLANA_MAINNET_REPORTER_SECRET",
      ["DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET"],
      ["DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET"],
    );
    if (mainnetTarget) {
      solanaTargets.push(mainnetTarget);
    }
  }

  if (enabled && solanaTargets.length === 0) {
    throw new Error(
      `Duel arena oracle is enabled for ${profile}, but no Solana authority or reporter secret is configured`,
    );
  }

  return {
    enabled,
    profile,
    metadataBaseUrl: resolveMetadataBaseUrl(),
    storePath: resolveStorePath(),
    solanaTargets,
    settlementDelayMs,
  };
}
