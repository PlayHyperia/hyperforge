import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateKillToken,
  isKillTokenValidationAvailable,
  MAX_MOB_COMBAT_DAMAGE,
  validateKillToken,
  validateKillTokenSignature,
} from "../KillTokenUtils";

const NOW = 1_788_087_600_000;
const SECRET = "kill-token-regression-secret-with-enough-entropy";
const MOB_ID = "mob-life-1";
const KILLER_ID = "agent-1";
const OPERATION_ID =
  "ground-item-mob-loot:123e4567-e89b-42d3-a456-426614174000";
const ATTACK_STYLE = "aggressive";
const DAMAGE_DEALT = 20;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("KILL_TOKEN_SECRET", SECRET);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("KillTokenUtils", () => {
  it("uses a production-ESM-compatible full HMAC-SHA256", async () => {
    const token = await generateKillToken(
      MOB_ID,
      KILLER_ID,
      NOW,
      OPERATION_ID,
      ATTACK_STYLE,
      DAMAGE_DEALT,
    );
    const expected = createHmac("sha256", SECRET)
      .update(
        JSON.stringify({
          version: 3,
          mobId: MOB_ID,
          killedBy: KILLER_ID,
          timestamp: NOW,
          lootOperationId: OPERATION_ID,
          attackStyle: ATTACK_STYLE,
          damageDealt: DAMAGE_DEALT,
        }),
      )
      .digest("hex");

    expect(isKillTokenValidationAvailable()).toBe(true);
    expect(token).toBe(expected);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(true);
  });

  it("binds every death-identity field and rejects malformed authority", async () => {
    const token = await generateKillToken(
      MOB_ID,
      KILLER_ID,
      NOW,
      OPERATION_ID,
      ATTACK_STYLE,
      DAMAGE_DEALT,
    );

    await expect(
      validateKillToken(
        "other-mob",
        KILLER_ID,
        NOW,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillToken(
        MOB_ID,
        "other-agent",
        NOW,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW + 1,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        token,
        "ground-item-mob-loot:not-a-uuid",
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        "00",
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        token,
        OPERATION_ID,
        "defensive",
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT + 1,
      ),
    ).resolves.toBe(false);
  });

  it("refuses to sign damage authority the durable transaction cannot accept", async () => {
    await expect(
      generateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        OPERATION_ID,
        ATTACK_STYLE,
        MAX_MOB_COMBAT_DAMAGE + 1,
      ),
    ).rejects.toThrow("kill_token_damage_authority_invalid");
  });

  it("rejects stale live events while allowing signed durable replay", async () => {
    const token = await generateKillToken(
      MOB_ID,
      KILLER_ID,
      NOW,
      OPERATION_ID,
      ATTACK_STYLE,
      DAMAGE_DEALT,
    );
    vi.spyOn(Date, "now").mockReturnValue(NOW + 5_001);

    await expect(
      validateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(false);
    await expect(
      validateKillTokenSignature(
        MOB_ID,
        KILLER_ID,
        NOW,
        token,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).resolves.toBe(true);
  });

  it("fails production signing closed when the configured secret is absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KILL_TOKEN_SECRET", "");

    await expect(
      generateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).rejects.toThrow("KILL_TOKEN_SECRET environment variable is required");
  });

  it("rejects a configured secret shorter than 32 bytes", async () => {
    vi.stubEnv("KILL_TOKEN_SECRET", "too-short");

    await expect(
      generateKillToken(
        MOB_ID,
        KILLER_ID,
        NOW,
        OPERATION_ID,
        ATTACK_STYLE,
        DAMAGE_DEALT,
      ),
    ).rejects.toThrow("KILL_TOKEN_SECRET must contain at least 32 bytes");
  });
});
