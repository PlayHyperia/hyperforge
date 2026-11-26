import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDuelArenaOracleConfig } from "../../../src/oracle/config.js";

function clearOracleEnv() {
  for (const key in process.env) {
    if (key.startsWith("DUEL_ARENA_ORACLE_")) {
      vi.stubEnv(key, "");
    }
  }
  vi.stubEnv("ORACLE_SETTLEMENT_DELAY_MS", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  clearOracleEnv();
});

describe("getDuelArenaOracleConfig", () => {
  it("builds only a Solana localnet target for the local profile", () => {
    process.env.DUEL_ARENA_ORACLE_ENABLED = "true";
    process.env.DUEL_ARENA_ORACLE_PROFILE = "local";
    process.env.DUEL_ARENA_ORACLE_ANVIL_CONTRACT_ADDRESS =
      "0x1111111111111111111111111111111111111111";
    process.env.DUEL_ARENA_ORACLE_ANVIL_PRIVATE_KEY =
      "0x1111111111111111111111111111111111111111111111111111111111111111";
    process.env.DUEL_ARENA_ORACLE_SOLANA_LOCALNET_AUTHORITY_SECRET =
      "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    process.env.DUEL_ARENA_ORACLE_SOLANA_LOCALNET_PROGRAM_ID =
      "6tpRysBFd1yXRipYEYwAw9jxEoVHk15kVXfkDGFLMqcD";

    const config = getDuelArenaOracleConfig();

    expect(config.enabled).toBe(true);
    expect(config.profile).toBe("local");
    expect(config).not.toHaveProperty("evmTargets");
    expect(config.solanaTargets).toHaveLength(1);
    expect(config.solanaTargets[0]?.key).toBe("solanaLocalnet");
    expect(config.solanaTargets[0]?.rpcUrl).toBe("http://127.0.0.1:8899");
    expect(config.solanaTargets[0]?.wsUrl).toBe("ws://127.0.0.1:8900");
  });

  it("fails closed when enabled without a Solana signer", () => {
    process.env.DUEL_ARENA_ORACLE_ENABLED = "true";
    process.env.DUEL_ARENA_ORACLE_PROFILE = "local";

    expect(() => getDuelArenaOracleConfig()).toThrow(
      "no Solana authority or reporter secret",
    );
  });

  it("uses the shared Solana secret and ignores legacy chain configuration", () => {
    process.env.DUEL_ARENA_ORACLE_ENABLED = "true";
    process.env.DUEL_ARENA_ORACLE_PROFILE = "testnet";
    process.env.DUEL_ARENA_ORACLE_EVM_PRIVATE_KEY =
      "0x2222222222222222222222222222222222222222222222222222222222222222";
    process.env.DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET =
      "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    process.env.DUEL_ARENA_ORACLE_BASE_SEPOLIA_CONTRACT_ADDRESS =
      "0x1111111111111111111111111111111111111111";
    process.env.DUEL_ARENA_ORACLE_BSC_TESTNET_CONTRACT_ADDRESS =
      "0x2222222222222222222222222222222222222222";
    process.env.DUEL_ARENA_ORACLE_AVAX_FUJI_CONTRACT_ADDRESS =
      "0x3333333333333333333333333333333333333333";

    const config = getDuelArenaOracleConfig();

    expect(config).not.toHaveProperty("evmTargets");
    expect(config.solanaTargets).toHaveLength(1);
    expect(config.solanaTargets[0]?.authoritySecret).toBe(
      process.env.DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET,
    );
    expect(config.solanaTargets[0]?.reporterSecret).toBeNull();
  });

  it("keeps the disabled default side-effect free without credentials", () => {
    const config = getDuelArenaOracleConfig();

    expect(config.enabled).toBe(false);
    expect(config.profile).toBe("testnet");
    expect(config.solanaTargets).toEqual([]);
  });

  it.each(["AVAX", "bsc", "base-sepolia"])(
    "rejects the legacy non-Solana profile %s",
    (profile) => {
      process.env.DUEL_ARENA_ORACLE_PROFILE = profile;

      expect(() => getDuelArenaOracleConfig()).toThrow(
        "DUEL_ARENA_ORACLE_PROFILE must be local, testnet, mainnet, or all",
      );
    },
  );

  it.each(["-1", "1.5", "7000ms", "9007199254740992"])(
    "rejects an unsafe settlement delay %s",
    (delay) => {
      process.env.ORACLE_SETTLEMENT_DELAY_MS = delay;

      expect(() => getDuelArenaOracleConfig()).toThrow(
        "ORACLE_SETTLEMENT_DELAY_MS must be a non-negative",
      );
    },
  );
});
