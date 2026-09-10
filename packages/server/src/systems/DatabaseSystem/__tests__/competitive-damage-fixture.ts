import type pg from "pg";

import {
  finalizeCompetitiveSnapshot,
  type CompetitiveSnapshotContestant,
} from "../../StreamingDuelScheduler/competitive-snapshot.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../../StreamingDuelScheduler/competitive-tactical-strategy.js";
import { COMPETITIVE_SNAPSHOT_TIMING_FIXTURE } from "../../StreamingDuelScheduler/__tests__/competitiveSnapshotTimingFixture.js";

export type CompetitiveDamageFixtureInput = Readonly<{
  preparationId: string;
  fencingToken: string;
  cycleId: string;
  duelId: string;
  duelKey: string;
  agent1Id: string;
  agent2Id: string;
  agent1Name: string;
  agent2Name: string;
  agent1MaxHp: number;
  agent2MaxHp: number;
  frozenAt: number;
  duelStartedAt: number;
}>;

function contestant(
  side: "agent1" | "agent2",
  agentId: string,
  name: string,
  maxHp: number,
): CompetitiveSnapshotContestant {
  const fingerprint = side === "agent1" ? "31".repeat(32) : "42".repeat(32);
  return {
    side,
    agentId,
    name,
    provider: "terminal-custody-test",
    model: "deterministic-test-v1",
    combatLevel: 10,
    startingHp: maxHp,
    maxHp,
    wins: 0,
    losses: 0,
    rank: side === "agent1" ? 1 : 2,
    headToHeadWins: 0,
    headToHeadLosses: 0,
    loadoutFingerprint: fingerprint,
    equipment: [{ slot: "weapon", itemId: "bronze_longsword", quantity: 1 }],
    inventory: [],
    selectedSpell: null,
    skillLevels: [
      { skill: "attack", level: 10 },
      { skill: "strength", level: 10 },
      { skill: "defense", level: 10 },
      { skill: "constitution", level: maxHp },
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
        weaponId: "bronze_longsword",
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
      planningPolicyVersion: "terminal-custody-test-v1",
      agentPolicyFingerprint: fingerprint,
      modelProvider: "terminal-custody-test",
      model: "deterministic-test-v1",
      tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
    },
  };
}

export async function seedCompetitiveDamageFixture(
  pool: pg.Pool,
  input: CompetitiveDamageFixtureInput,
): Promise<{ snapshotDigest: string }> {
  const timing = {
    ...COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
    countdownDurationMs: 1,
  };
  const betWindowDurationMs =
    input.duelStartedAt - input.frozenAt - timing.countdownDurationMs;
  if (betWindowDurationMs <= 0) {
    throw new Error("competitive damage fixture timing invalid");
  }
  const finalized = finalizeCompetitiveSnapshot({
    persisted: true,
    frozenAt: input.frozenAt,
    betWindowDurationMs,
    timing,
    draft: {
      diagnostic: false,
      preparationId: input.preparationId,
      cycleId: input.cycleId,
      duelId: input.duelId,
      duelKey: input.duelKey,
      contestants: [
        contestant(
          "agent1",
          input.agent1Id,
          input.agent1Name,
          input.agent1MaxHp,
        ),
        contestant(
          "agent2",
          input.agent2Id,
          input.agent2Name,
          input.agent2MaxHp,
        ),
      ],
    },
  });
  const expiresAt = input.duelStartedAt + 60_000;
  await pool.query(
    `INSERT INTO streaming_duel_preparations (
       "preparationId", "fencingToken", "agent1Id", "agent2Id",
       "allowedBankActions", status, "selectedAt", "expiresAt",
       "agent1ReadyAt", "agent2ReadyAt", "agent1PlanEvidence",
       "agent2PlanEvidence", "frozenAt", version
     ) VALUES (
       $1, $2::bigint, $3, $4, ARRAY['open']::text[], 'frozen', $5::bigint,
       $6::bigint, $7::bigint, $7::bigint, $8::jsonb, $9::jsonb,
       $7::bigint, 4
     )`,
    [
      input.preparationId,
      input.fencingToken,
      input.agent1Id,
      input.agent2Id,
      input.frozenAt - 1_000,
      expiresAt,
      input.frozenAt,
      JSON.stringify(finalized.snapshot.contestants[0].preparation),
      JSON.stringify(finalized.snapshot.contestants[1].preparation),
    ],
  );
  await pool.query(
    `INSERT INTO streaming_duel_competitive_snapshots (
       "preparationId", "snapshotVersion", "cycleId", "duelId", "duelKey",
       "snapshotDigest", snapshot, "frozenAt", "lockedAt", "duelStartedAt",
       "lifecycleStatus"
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8::bigint, $9::bigint,
       $10::bigint, 'frozen'
     )`,
    [
      input.preparationId,
      finalized.snapshot.snapshotVersion,
      input.cycleId,
      input.duelId,
      input.duelKey,
      finalized.digest,
      JSON.stringify(finalized.snapshot),
      input.frozenAt,
      input.frozenAt,
      input.duelStartedAt,
    ],
  );
  return { snapshotDigest: finalized.digest };
}
