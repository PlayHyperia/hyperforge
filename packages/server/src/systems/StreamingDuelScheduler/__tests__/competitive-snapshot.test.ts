import { describe, expect, it, vi } from "vitest";

import {
  assertValidCompetitiveSnapshot,
  canonicalCompetitiveSnapshotJson,
  competitiveSnapshotMismatchPaths,
  digestCompetitiveSnapshot,
  finalizeCompetitiveSnapshot,
  type CompetitiveSnapshotContestant,
} from "../competitive-snapshot.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../competitive-tactical-strategy.js";
import { buildCompetitiveTerminalStatUpdates } from "../competitive-terminal-stats.js";
import { PostgresDuelPreparationStore } from "../preparation.js";
import { COMPETITIVE_SNAPSHOT_TIMING_FIXTURE } from "./competitiveSnapshotTimingFixture.js";

function contestant(side: "agent1" | "agent2"): CompetitiveSnapshotContestant {
  const agentId = side === "agent1" ? "agent-alpha" : "agent-beta";
  const hash = side === "agent1" ? "11".repeat(32) : "22".repeat(32);
  return {
    side,
    agentId,
    name: side === "agent1" ? "Agent Alpha" : "Agent Beta",
    provider: "test-provider",
    model: `${agentId}-model`,
    combatLevel: 42,
    startingHp: 30,
    maxHp: 30,
    wins: 10,
    losses: 5,
    rank: side === "agent1" ? 1 : 2,
    headToHeadWins: 2,
    headToHeadLosses: 1,
    loadoutFingerprint: hash,
    equipment: [{ slot: "weapon", itemId: "iron_sword", quantity: 1 }],
    inventory: [{ slot: 0, itemId: "shark", quantity: 2 }],
    selectedSpell: null,
    skillLevels: [
      { skill: "strength", level: 40 },
      { skill: "attack", level: 40 },
    ],
    prayer: {
      pointUnits: 10_000_000,
      points: 10,
      maxPoints: 10,
      activePrayers: [],
    },
    initialCombatStyle: "melee",
    availableCombatStyles: ["melee"],
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "iron_sword",
        arrowsId: null,
        shieldId: null,
        spellId: null,
        armorIds: {
          helmet: null,
          body: null,
          legs: null,
          boots: null,
          gloves: null,
          cape: null,
          amulet: null,
          ring: null,
        },
      },
    },
    preparation: {
      primaryStyle: "melee",
      availableStyles: ["melee"],
      planningSource: "deterministic",
      planningPolicyVersion: "test-policy-v1",
      agentPolicyFingerprint: hash,
      modelProvider: "test-provider",
      model: `${agentId}-model`,
      tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
    },
  };
}

function finalize(
  agent1 = contestant("agent1"),
  agent2 = contestant("agent2"),
) {
  return finalizeCompetitiveSnapshot({
    persisted: true,
    frozenAt: 1_800_000_000_000,
    betWindowDurationMs: 60_000,
    timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
    draft: {
      diagnostic: false,
      preparationId: "11111111-1111-4111-a111-111111111111",
      cycleId: "competitive-cycle-1",
      duelId: "streaming-competitive-cycle-1",
      duelKey: "ab".repeat(32),
      contestants: [agent1, agent2],
    },
  });
}

function recursiveKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(recursiveKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) => [key, ...recursiveKeys(nested)],
  );
}

describe("competitive snapshot contract", () => {
  it("normalizes unordered custody data and produces a stable semantic digest", () => {
    const alpha = contestant("agent1");
    alpha.inventory = [
      { slot: 5, itemId: "prayer_potion", quantity: 1 },
      { slot: 0, itemId: "shark", quantity: 2 },
    ];
    alpha.skillLevels = [
      { skill: "strength", level: 40 },
      { skill: "attack", level: 40 },
    ];
    const first = finalize(alpha);
    const second = finalize({
      ...alpha,
      inventory: [...alpha.inventory].reverse(),
      skillLevels: [...alpha.skillLevels].reverse(),
    });

    expect(
      first.snapshot.contestants[0].inventory.map(({ slot }) => slot),
    ).toEqual([0, 5]);
    expect(
      first.snapshot.contestants[0].skillLevels.map(({ skill }) => skill),
    ).toEqual(["attack", "strength"]);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(digestCompetitiveSnapshot(first.snapshot));
  });

  it("reports bounded value-free mismatch paths for recovery diagnostics", () => {
    const expected = finalize().snapshot;
    const actual = structuredClone(expected);
    actual.contestants[0].inventory[0]!.quantity = 987_654_321;
    actual.contestants[1].skillLevels[0]!.level = 73;

    const paths = competitiveSnapshotMismatchPaths(expected, actual, 1);

    expect(paths).toEqual(["$.contestants[0].inventory[0].quantity"]);
    expect(paths.join(" ")).not.toContain("987654321");
    expect(paths.join(" ")).not.toContain("73");
  });

  it("binds the exact sporting clock and timeout policy before betting opens", () => {
    const { snapshot } = finalize();
    expect(snapshot.timing).toEqual({
      ...COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
      fightStartTime:
        snapshot.betCloseTime +
        COMPETITIVE_SNAPSHOT_TIMING_FIXTURE.countdownDurationMs,
      fightDeadline:
        snapshot.betCloseTime +
        COMPETITIVE_SNAPSHOT_TIMING_FIXTURE.countdownDurationMs +
        COMPETITIVE_SNAPSHOT_TIMING_FIXTURE.maxFightDurationMs,
    });
  });

  it("rejects any post-freeze sporting-clock or timeout-policy mutation", () => {
    const { snapshot } = finalize();
    const changedDeadline = structuredClone(snapshot);
    changedDeadline.timing!.fightDeadline += 1;
    expect(() => assertValidCompetitiveSnapshot(changedDeadline)).toThrow(
      /timing contract/u,
    );

    const changedPolicy = structuredClone(snapshot);
    (changedPolicy.timing as { timeoutPolicy: string }).timeoutPolicy =
      "unbound_policy";
    expect(() => assertValidCompetitiveSnapshot(changedPolicy)).toThrow(
      /timing contract/u,
    );
  });

  it("copies only the public allowlist and strips injected private custody fields", () => {
    const alpha = contestant("agent1") as CompetitiveSnapshotContestant & {
      bank?: unknown;
      walletSecret?: string;
    };
    alpha.bank = [{ itemId: "private_bank_item", quantity: 99 }];
    alpha.walletSecret = "must-not-leak";
    (alpha.equipment[0] as unknown as Record<string, unknown>).ownerToken =
      "private-token";
    (alpha.prayer as unknown as Record<string, unknown>).databaseReceipt =
      "private-receipt";
    (alpha.combatLoadouts.melee as unknown as Record<string, unknown>).secret =
      "private-loadout-secret";

    const { snapshot } = finalize(alpha);
    const serialized = canonicalCompetitiveSnapshotJson(snapshot);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("private_");
    expect(recursiveKeys(snapshot)).not.toEqual(
      expect.arrayContaining([
        "bank",
        "walletSecret",
        "ownerToken",
        "databaseReceipt",
        "secret",
      ]),
    );
  });

  it("rejects duplicate inventory slots before a market can be announced", () => {
    const alpha = contestant("agent1");
    alpha.inventory.push({ slot: 0, itemId: "prayer_potion", quantity: 1 });
    expect(() => finalize(alpha)).toThrow(/agent1 inventory/);
  });

  it("rejects planning evidence that does not identify the public contestant model", () => {
    const alpha = contestant("agent1");
    alpha.preparation.model = "different-model";
    expect(() => finalize(alpha)).toThrow(/agent1 preparation/);
  });

  it("rejects a bet window whose end overflows JavaScript safe integers", () => {
    expect(() =>
      finalizeCompetitiveSnapshot({
        persisted: true,
        frozenAt: Number.MAX_SAFE_INTEGER - 10,
        betWindowDurationMs: 60_000,
        timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
        draft: {
          diagnostic: false,
          preparationId: "11111111-1111-4111-a111-111111111111",
          cycleId: "overflow-cycle",
          duelId: "streaming-overflow-cycle",
          duelKey: "ab".repeat(32),
          contestants: [contestant("agent1"), contestant("agent2")],
        },
      }),
    ).toThrow(/timing/);
  });

  it("supports an isolated non-bettable diagnostic prayer snapshot", () => {
    const diagnostic = (side: "agent1" | "agent2") => {
      const value = contestant(side);
      value.loadoutFingerprint = null;
      value.initialCombatStyle = "prayer";
      value.availableCombatStyles = ["prayer"];
      value.combatLoadouts = {};
      value.preparation = {
        primaryStyle: "prayer",
        availableStyles: ["prayer"],
        planningSource: "diagnostic",
        planningPolicyVersion: "diagnostic-v1",
        agentPolicyFingerprint: null,
        modelProvider: value.provider,
        model: value.model,
        tacticalStrategy:
          buildDeterministicCompetitiveTacticalStrategy("prayer"),
      };
      return value;
    };
    const { snapshot } = finalizeCompetitiveSnapshot({
      persisted: false,
      frozenAt: 1_800_000_000_000,
      betWindowDurationMs: 60_000,
      timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
      draft: {
        diagnostic: true,
        preparationId: null,
        cycleId: "diagnostic-cycle",
        duelId: "streaming-diagnostic-cycle",
        duelKey: "cd".repeat(32),
        contestants: [diagnostic("agent1"), diagnostic("agent2")],
      },
    });
    expect(snapshot).toMatchObject({
      persisted: false,
      diagnostic: true,
      preparationId: null,
    });
  });

  it("rejects extra keys when validating a snapshot loaded back from JSONB", () => {
    const { snapshot } = finalize();
    expect(() =>
      assertValidCompetitiveSnapshot({
        ...snapshot,
        privateBankSnapshot: [],
      }),
    ).toThrow(/shape/);
  });

  it("requires the frozen tactical strategy in every current snapshot", () => {
    const { snapshot } = finalize();
    const missing = structuredClone(snapshot) as unknown as Record<
      string,
      unknown
    >;
    const contestants = missing.contestants as Array<{
      preparation: Record<string, unknown>;
    }>;
    delete contestants[0]!.preparation.tacticalStrategy;

    expect(() => assertValidCompetitiveSnapshot(missing)).toThrow(
      /agent1 preparation/,
    );
  });

  it("requires an exact eight-slot armor map in every current role loadout", () => {
    const { snapshot } = finalize();
    const missing = structuredClone(snapshot);
    delete missing.contestants[0].combatLoadouts.melee?.armorIds;

    expect(() => assertValidCompetitiveSnapshot(missing)).toThrow(
      /agent1 combat loadouts/,
    );
  });

  it("can validate a schema-v2 snapshot for terminal inspection without reinterpreting armor", () => {
    const { snapshot } = finalize();
    const legacy = structuredClone(snapshot);
    legacy.snapshotVersion = 2;
    legacy.combatPolicyVersion = "duel-combat-policy-v1";
    delete legacy.timing;
    for (const entry of legacy.contestants) {
      for (const loadout of Object.values(entry.combatLoadouts)) {
        if (loadout) delete loadout.armorIds;
      }
    }

    expect(() => assertValidCompetitiveSnapshot(legacy)).not.toThrow();
  });

  it("can validate a schema-v3 snapshot without inventing a historical clock", () => {
    const { snapshot } = finalize();
    const legacy = structuredClone(snapshot);
    legacy.snapshotVersion = 3;
    delete legacy.timing;

    expect(() => assertValidCompetitiveSnapshot(legacy)).not.toThrow();
  });

  it("can validate a legacy snapshot for terminal inspection without making it current", () => {
    const { snapshot } = finalize();
    const legacy = structuredClone(snapshot);
    legacy.snapshotVersion = 1;
    legacy.combatPolicyVersion = "duel-combat-policy-v1";
    delete legacy.timing;
    for (const entry of legacy.contestants) {
      delete entry.preparation.tacticalStrategy;
      for (const loadout of Object.values(entry.combatLoadouts)) {
        if (loadout) delete loadout.armorIds;
      }
    }

    expect(() => assertValidCompetitiveSnapshot(legacy)).not.toThrow();
  });
});

describe("competitive recovery custody hold query", () => {
  it("returns only validated contestant identities from the active recovery set", async () => {
    const { snapshot } = finalize();
    const query = vi.fn(async (sql: string) => ({
      rows: [
        {
          preparationId: snapshot.preparationId,
          agent1Id: snapshot.contestants[0].agentId,
          agent2Id: snapshot.contestants[1].agentId,
          snapshot,
        },
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    const store = new PostgresDuelPreparationStore({ query } as never);

    await expect(store.listCompetitiveRecoveryCustodyHolds()).resolves.toEqual([
      {
        preparationId: snapshot.preparationId,
        agent1Id: "agent-alpha",
        agent2Id: "agent-beta",
      },
    ]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain(
      `snapshot."lifecycleStatus" IN ('frozen', 'terminal')`,
    );
    expect(sql).toContain(`snapshot."recoveredAt" IS NULL`);
    expect(sql).toContain("preparation.status = 'frozen'");
  });

  it("fails closed when relational contestant ownership disagrees with the snapshot", async () => {
    const { snapshot } = finalize();
    const query = vi.fn(async () => ({
      rows: [
        {
          preparationId: snapshot.preparationId,
          agent1Id: "agent-beta",
          agent2Id: "agent-alpha",
          snapshot,
        },
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    const store = new PostgresDuelPreparationStore({ query } as never);

    await expect(store.listCompetitiveRecoveryCustodyHolds()).rejects.toThrow(
      /custody hold is invalid/u,
    );
  });
});

describe("competitive terminal aggregate contract", () => {
  it("derives exact winner, loser, anchor, and two-sided damage updates", () => {
    const { snapshot } = finalize();
    const terminalAt = snapshot.frozenAt + 10;

    expect(
      buildCompetitiveTerminalStatUpdates(
        snapshot,
        { outcome: "win", winnerId: "agent-alpha", terminalAt },
        new Map([
          ["agent-alpha", 17],
          ["agent-beta", 9],
        ]),
      ),
    ).toEqual([
      expect.objectContaining({
        agentId: "agent-alpha",
        opponentId: "agent-beta",
        result: "win",
        winDelta: 1,
        lossDelta: 0,
        drawDelta: 0,
        anchoredWins: 11,
        anchoredLosses: 5,
        damageDealt: 17,
        damageTaken: 9,
        terminalAt,
      }),
      expect.objectContaining({
        agentId: "agent-beta",
        opponentId: "agent-alpha",
        result: "loss",
        winDelta: 0,
        lossDelta: 1,
        drawDelta: 0,
        anchoredWins: 10,
        anchoredLosses: 6,
        damageDealt: 9,
        damageTaken: 17,
        terminalAt,
      }),
    ]);
  });

  it("derives draws, ignores cancellations, and rejects foreign damage", () => {
    const { snapshot } = finalize();
    const terminalAt = snapshot.frozenAt + 10;
    expect(
      buildCompetitiveTerminalStatUpdates(
        snapshot,
        { outcome: "draw", winnerId: null, terminalAt },
        new Map(),
      ),
    ).toEqual([
      expect.objectContaining({
        agentId: "agent-alpha",
        result: "draw",
        drawDelta: 1,
        anchoredWins: 10,
        anchoredLosses: 5,
      }),
      expect.objectContaining({
        agentId: "agent-beta",
        result: "draw",
        drawDelta: 1,
        anchoredWins: 10,
        anchoredLosses: 5,
      }),
    ]);
    expect(
      buildCompetitiveTerminalStatUpdates(
        snapshot,
        { outcome: "cancelled", winnerId: null, terminalAt },
        new Map(),
      ),
    ).toEqual([]);
    expect(() =>
      buildCompetitiveTerminalStatUpdates(
        snapshot,
        { outcome: "win", winnerId: "agent-alpha", terminalAt },
        new Map([["foreign-agent", 1]]),
      ),
    ).toThrow("competitive_terminal_stats_damage_invalid");
  });
});
