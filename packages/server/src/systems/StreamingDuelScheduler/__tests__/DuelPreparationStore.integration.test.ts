import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  DUEL_PREPARATION_ROLE_POLICY_VERSION,
  EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
  ITEMS,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeDuelPreparationBankAccess,
  DUEL_PREPARATION_BANK_ACTIONS,
  PostgresDuelPreparationStore,
} from "../preparation.js";
import {
  executeAuthoritativeAgentBankTransfer,
  getDuelPreparationBankId,
  openAuthoritativeAgentBank,
} from "../../../eliza/AuthoritativeAgentBanking.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../competitive-tactical-strategy.js";
import { buildCompetitiveStrategyOutcomeReport } from "../competitive-strategy-outcome-metrics.js";
import {
  executeOwnedAgentMutation,
  updatePersistedStreamingDuelParticipation,
} from "../../../database/streaming-duel-participation.js";
import { COMPETITIVE_SNAPSHOT_TIMING_FIXTURE } from "./competitiveSnapshotTimingFixture.js";

const connectionString = process.env.DUEL_PREPARATION_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const planEvidence = (agentId: string) => ({
  primaryStyle: "melee" as const,
  availableStyles: ["melee" as const],
  planningSource: "deterministic" as const,
  planningPolicyVersion: "test-policy-v1",
  agentPolicyFingerprint: "ab".repeat(32),
  modelProvider: "test",
  model: agentId,
  tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
});

const snapshotContestant = (side: "agent1" | "agent2", agentId: string) => ({
  side,
  agentId,
  name: agentId,
  provider: "test",
  model: agentId,
  combatLevel: 10,
  startingHp: 20,
  maxHp: 20,
  wins: 0,
  losses: 0,
  rank: side === "agent1" ? 1 : 2,
  headToHeadWins: 0,
  headToHeadLosses: 0,
  loadoutFingerprint: (side === "agent1" ? "11" : "22").repeat(32),
  equipment: [{ slot: "weapon", itemId: "bronze_sword", quantity: 1 }],
  inventory: [{ slot: 0, itemId: "shark", quantity: 2 }],
  selectedSpell: null,
  skillLevels: [
    { skill: "attack", level: 10 },
    { skill: "constitution", level: 20 },
  ],
  prayer: {
    pointUnits: 100,
    points: 10,
    maxPoints: 10,
    activePrayers: [],
  },
  initialCombatStyle: "melee" as const,
  availableCombatStyles: ["melee" as const],
  combatLoadouts: {
    melee: {
      role: "melee" as const,
      weaponId: "bronze_sword",
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
  preparation: planEvidence(agentId),
});

describeWithDatabase("PostgresDuelPreparationStore integration", () => {
  const pool = new pg.Pool({ connectionString, max: 4 });
  const store = new PostgresDuelPreparationStore(pool);
  const runId = randomUUID();
  const agent1Id = `preparation-agent-1-${runId}`;
  const agent2Id = `preparation-agent-2-${runId}`;
  const agent3Id = `preparation-agent-3-${runId}`;
  const account1Id = `preparation-account-1-${runId}`;
  const account2Id = `preparation-account-2-${runId}`;
  const account3Id = `preparation-account-3-${runId}`;
  const bankItemId = "preparation_integration_item";
  const hostOwnerId = randomUUID();
  let previousBankItem: unknown;

  const claimHostLeases = async (preparation: {
    preparationId: string;
    agent1Id: string;
    agent2Id: string;
  }): Promise<void> => {
    for (const agentId of [preparation.agent1Id, preparation.agent2Id]) {
      await expect(
        store.claimContestantHostLease({
          preparationId: preparation.preparationId,
          agentId,
          ownerId: hostOwnerId,
          leaseDurationMs: 60_000,
        }),
      ).resolves.toMatchObject({
        preparationId: preparation.preparationId,
        agentId,
        ownerId: hostOwnerId,
      });
    }
  };

  beforeAll(async () => {
    previousBankItem = ITEMS.get(bankItemId);
    ITEMS.set(bankItemId, {
      id: bankItemId,
      name: "Preparation Integration Item",
      type: "resource",
      stackable: true,
    } as never);
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES
         ($1, 'Preparation Account 1', '[]', '2026-01-01T00:00:00.000Z'),
         ($2, 'Preparation Account 2', '[]', '2026-01-01T00:00:00.000Z'),
         ($3, 'Preparation Account 3', '[]', '2026-01-01T00:00:00.000Z')
       ON CONFLICT (id) DO NOTHING`,
      [account1Id, account2Id, account3Id],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name)
       VALUES
         ($1, $4, 'Preparation Agent 1'),
         ($2, $5, 'Preparation Agent 2'),
         ($3, $6, 'Preparation Agent 3')
       ON CONFLICT (id) DO NOTHING`,
      [agent1Id, agent2Id, agent3Id, account1Id, account2Id, account3Id],
    );
    await pool.query(
      `INSERT INTO agent_mappings (
         agent_id, account_id, character_id, agent_name,
         streaming_duel_enabled, created_at, updated_at
       ) VALUES
         ($1, $4, $1, 'Preparation Agent 1', true, NOW(), NOW()),
         ($2, $5, $2, 'Preparation Agent 2', true, NOW(), NOW()),
         ($3, $6, $3, 'Preparation Agent 3', true, NOW(), NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         streaming_duel_enabled = EXCLUDED.streaming_duel_enabled,
         updated_at = NOW()`,
      [agent1Id, agent2Id, agent3Id, account1Id, account2Id, account3Id],
    );
  });

  afterAll(async () => {
    // Preparation, transition, and bank-operation evidence is deliberately
    // append-only. Unique per-run identities avoid collisions without asking
    // teardown to violate the same immutability contract this suite verifies.
    if (previousBankItem) ITEMS.set(bankItemId, previousBankItem as never);
    else ITEMS.delete(bankItemId);
    await pool.end();
  });

  it("rejects private preparation unless both mappings are explicitly enabled", async () => {
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account2Id,
        agentId: agent2Id,
        enabled: false,
      }),
    ).toMatchObject({ status: "updated" });
    await expect(
      store.create({
        preparationId: randomUUID(),
        fencingToken: "3",
        agent1Id,
        agent2Id,
        diagnostic: false,
        durationMs: 60_000,
        allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
      }),
    ).rejects.toThrow(/competitive_contestant_participation_not_enabled/u);
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account2Id,
        agentId: agent2Id,
        enabled: true,
      }),
    ).toMatchObject({ status: "updated" });
  });

  it("persists selection and supersedes the prior private session", async () => {
    const first = await store.create({
      preparationId: randomUUID(),
      fencingToken: "4",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    const retry = await store.create({
      preparationId: first.preparationId,
      fencingToken: "4",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    expect(retry).toEqual(first);

    const second = await store.create({
      preparationId: randomUUID(),
      fencingToken: "4",
      agent1Id,
      agent2Id: agent3Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });

    expect(second).toMatchObject({
      status: "preparing",
      agent1Id,
      agent2Id: agent3Id,
      version: 1,
    });
    expect(await store.get(first.preparationId)).toMatchObject({
      status: "cancelled",
      cancellationReason: "superseded",
      version: 2,
    });
    expect(await store.getActive()).toMatchObject({
      preparationId: second.preparationId,
    });
    expect(
      (await store.getTransitionHistory(first.preparationId)).map(
        (event) => event.eventType,
      ),
    ).toEqual(["preparation_selected", "preparation_cancelled"]);
    expect(await store.getTransitionHistory(first.preparationId)).toEqual([
      expect.objectContaining({
        eventSource: "runtime",
        preparationId: first.preparationId,
        eventType: "preparation_selected",
        preparationVersion: 1,
        reason: null,
      }),
      expect.objectContaining({
        eventSource: "runtime",
        preparationId: first.preparationId,
        eventType: "preparation_cancelled",
        preparationVersion: 2,
        reason: "superseded",
      }),
    ]);
  });

  it("retains a bounded privacy-safe public activity trail across restart", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "401",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);

    const planning = await store.appendPublicActivity({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      ownerId: hostOwnerId,
      activity: "planning",
      mode: "working",
    });
    await expect(
      store.appendPublicActivity({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
        ownerId: hostOwnerId,
        activity: "planning",
        mode: "working",
      }),
    ).resolves.toEqual(planning);
    const traveling = await store.appendPublicActivity({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      ownerId: hostOwnerId,
      activity: "gathering",
      mode: "traveling",
    });
    const provisioning = await store.appendPublicActivity({
      preparationId: preparation.preparationId,
      agentId: agent2Id,
      ownerId: hostOwnerId,
      activity: "provisioning",
      mode: "working",
    });

    expect(
      await store.listRecentPublicActivities(preparation.preparationId),
    ).toEqual([planning, traveling, provisioning]);
    await expect(
      store.appendPublicActivity({
        preparationId: preparation.preparationId,
        agentId: agent3Id,
        ownerId: hostOwnerId,
        activity: "training",
        mode: "working",
      }),
    ).rejects.toThrow("duel_preparation_public_activity_not_authorized");
    await expect(
      pool.query(
        `UPDATE streaming_duel_preparation_public_activities
         SET activity = 'training'
         WHERE "activitySequence" = $1`,
        [planning.revision],
      ),
    ).rejects.toThrow(/append-only/u);
  });

  it("immutably binds external public strategy context to the exact live host", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "402",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    const context = {
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      hostOwnerId,
      policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
      protocolVersion: EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
      agentName: "Preparation Agent 1",
      opponentName: "Preparation Agent 2",
      ownPublicProfile: {
        narrative: "Patient adaptive fighter.",
        pillars: ["spacing", "resource control"],
      },
      opponentPublicProfile: {
        narrative: "Aggressive ranged fighter.",
        pillars: ["pressure"],
      },
      opponentHistorySummary: {
        sampleSize: 1,
        observedOpponentOpeningStyleFocus: "ranged" as const,
        recent: [
          {
            result: "loss" as const,
            ownOpeningStyle: "melee" as const,
            opponentOpeningStyle: "ranged" as const,
            winReason: "kill" as const,
          },
        ],
      },
    };

    const bound = await store.bindStrategyContext(context);
    expect(bound).toMatchObject({
      ...context,
      boundAt: expect.any(Number),
    });
    await expect(store.bindStrategyContext(context)).resolves.toEqual(bound);
    await expect(
      store.bindStrategyContext({
        ...context,
        opponentName: "Mutable Opponent Name",
      }),
    ).rejects.toThrow("duel_preparation_strategy_context_conflict");
    await expect(
      store.bindStrategyContext({
        ...context,
        opponentHistorySummary: {
          sampleSize: 0,
          observedOpponentOpeningStyleFocus: null,
          recent: [],
        },
      }),
    ).rejects.toThrow("duel_preparation_strategy_context_conflict");
    await expect(
      pool.query(
        `INSERT INTO streaming_duel_preparation_strategy_contexts (
          "preparationId", "agentId", "hostOwnerId", "policyVersion",
          "protocolVersion", "agentName", "opponentName",
          "ownPublicProfile", "opponentPublicProfile",
          "opponentHistorySummary", "boundAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8::jsonb, 0)`,
        [
          preparation.preparationId,
          agent2Id,
          hostOwnerId,
          DUEL_PREPARATION_ROLE_POLICY_VERSION,
          EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
          "Preparation Agent 2",
          "Preparation Agent 1",
          JSON.stringify({
            sampleSize: 1,
            observedOpponentOpeningStyleFocus: "mage",
            recent: [
              {
                result: "loss",
                ownOpeningStyle: "melee",
                opponentOpeningStyle: "ranged",
                winReason: "kill",
              },
            ],
          }),
        ],
      ),
    ).rejects.toThrow(/history focus is not canonical/u);
    await expect(
      store.bindStrategyContext({
        ...context,
        hostOwnerId: randomUUID(),
      }),
    ).rejects.toThrow(/exact active contestant host lease/u);
    await expect(
      pool.query(
        `UPDATE streaming_duel_preparation_strategy_contexts
            SET "opponentName" = 'Mutated'
          WHERE "preparationId" = $1 AND "agentId" = $2`,
        [preparation.preparationId, agent1Id],
      ),
    ).rejects.toThrow(/append-only/u);
  });

  it("fences readiness and bank custody to one non-revivable database-clock host lease", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "400",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent1Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_not_active" });
    expect(
      await store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: "400",
        agentId: agent1Id,
        planEvidence: planEvidence(agent1Id),
      }),
    ).toBeNull();

    const shortOwnerId = randomUUID();
    const executableBuildId = "55".repeat(32);
    const shortLease = await store.claimContestantHostLease({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      ownerId: shortOwnerId,
      executableBuildId,
      leaseDurationMs: 5_000,
    });
    expect(shortLease).toMatchObject({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      ownerId: shortOwnerId,
      executableBuildId,
    });
    expect(
      await store.claimContestantHostLease({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
        ownerId: shortOwnerId,
        executableBuildId,
        leaseDurationMs: 5_000,
      }),
    ).toEqual(shortLease);
    expect(
      await store.claimContestantHostLease({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
        ownerId: randomUUID(),
        executableBuildId,
        leaseDurationMs: 5_000,
      }),
    ).toBeNull();
    expect(
      await store.claimContestantHostLease({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
        ownerId: shortOwnerId,
        executableBuildId: "66".repeat(32),
        leaseDurationMs: 5_000,
      }),
    ).toBeNull();
    await expect(
      pool.query(
        `UPDATE streaming_duel_preparation_agent_host_leases
            SET "executableBuildId" = $3
          WHERE "preparationId" = $1 AND "agentId" = $2`,
        [preparation.preparationId, agent1Id, "66".repeat(32)],
      ),
    ).rejects.toThrow(/executable build identity is immutable/u);
    await expect(
      store.claimContestantHostLease({
        preparationId: preparation.preparationId,
        agentId: agent2Id,
        ownerId: hostOwnerId,
        leaseDurationMs: 60_000,
      }),
    ).resolves.toMatchObject({ agentId: agent2Id, ownerId: hostOwnerId });
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent1Id,
        action: "open",
      }),
    ).toMatchObject({ ok: true });

    await pool.query("SELECT pg_sleep(5.1)");
    const expired = await store.reportExpiredContestantHostLease({
      preparationId: preparation.preparationId,
      claimGraceMs: 1_000,
    });
    expect(expired).toMatchObject({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      reason: "agent_unavailable",
    });
    expect(
      await store.heartbeatContestantHostLease({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
        ownerId: shortOwnerId,
        executableBuildId,
        leaseDurationMs: 5_000,
      }),
    ).toBeNull();
    expect(
      await store.claimContestantHostLease({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
        ownerId: randomUUID(),
        executableBuildId,
        leaseDurationMs: 5_000,
      }),
    ).toBeNull();
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent2Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_not_active" });
    expect(
      await store.freeze({
        preparationId: preparation.preparationId,
        fencingToken: "400",
      }),
    ).toBeNull();
    await expect(
      pool.query(
        `DELETE FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1`,
        [preparation.preparationId],
      ),
    ).rejects.toThrow(/retained for audit/u);

    await expect(
      store.cancel({
        preparationId: preparation.preparationId,
        fencingToken: "400",
        reason: "agent_preparation_failed",
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("durably fences a reported unavailable contestant before private state can freeze", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "401",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "401",
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    const ready = await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "401",
      agentId: agent2Id,
      planEvidence: planEvidence(agent2Id),
    });
    expect(ready?.status).toBe("ready");

    const reported = await store.reportContestantUnavailable({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
    });
    expect(reported).toEqual({
      preparationId: preparation.preparationId,
      agentId: agent1Id,
      reason: "agent_unavailable",
      reportedAt: expect.any(Number),
    });
    expect(
      await store.reportContestantUnavailable({
        preparationId: preparation.preparationId,
        agentId: agent1Id,
      }),
    ).toEqual(reported);
    expect(
      await store.getContestantUnavailability(preparation.preparationId),
    ).toEqual(reported);
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent2Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_not_active" });
    expect(
      await store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: "401",
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      }),
    ).toBeNull();
    expect(
      await store.freeze({
        preparationId: preparation.preparationId,
        fencingToken: "401",
      }),
    ).toBeNull();
    expect(
      await store.freezeWithCompetitiveSnapshot({
        preparationId: preparation.preparationId,
        fencingToken: "401",
        draft: {
          diagnostic: false,
          preparationId: preparation.preparationId,
          cycleId: randomUUID(),
          duelId: `streaming-${randomUUID()}`,
          duelKey: "91".repeat(32),
          contestants: [
            snapshotContestant("agent1", agent1Id),
            snapshotContestant("agent2", agent2Id),
          ],
        },
        betWindowDurationMs: 60_000,
        timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
      }),
    ).toBeNull();

    const cancelled = await store.cancel({
      preparationId: preparation.preparationId,
      fencingToken: "401",
      reason: "agent_preparation_failed",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellationReason: "agent_preparation_failed",
      version: 5,
    });
    expect(
      await store.reportContestantUnavailable({
        preparationId: preparation.preparationId,
        agentId: agent2Id,
      }),
    ).toBeNull();
    expect(
      await store.getContestantUnavailability(preparation.preparationId),
    ).toEqual(reported);

    await expect(
      pool.query(
        `UPDATE streaming_duel_preparation_unavailability_reports
            SET "reportedAt" = 0
          WHERE "preparationId" = $1`,
        [preparation.preparationId],
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query(
        `DELETE FROM streaming_duel_preparation_unavailability_reports
          WHERE "preparationId" = $1`,
        [preparation.preparationId],
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query(`TRUNCATE streaming_duel_preparation_unavailability_reports`),
    ).rejects.toThrow(/append-only/u);
  });

  it("revokes each contestant's bank access at readiness and freezes only both-ready state", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "5",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);

    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent1Id,
        action: "open",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent3Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_agent_mismatch" });
    expect(
      await store.freeze({
        preparationId: preparation.preparationId,
        fencingToken: "5",
      }),
    ).toBeNull();

    const firstReady = await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "5",
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    expect(firstReady).toMatchObject({
      status: "preparing",
      version: 2,
    });
    expect(firstReady?.agent1ReadyAt).not.toBeNull();
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent1Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_agent_ready" });
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent2Id,
        action: "open",
      }),
    ).toMatchObject({ ok: true });

    const ready = await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "5",
      agentId: agent2Id,
      planEvidence: planEvidence(agent2Id),
    });
    expect(ready).toMatchObject({ status: "ready", version: 3 });
    expect(
      await store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: "5",
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      }),
    ).toEqual(ready);
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent2Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_not_active" });

    const frozen = await store.freeze({
      preparationId: preparation.preparationId,
      fencingToken: "5",
    });
    expect(frozen).toMatchObject({ status: "frozen", version: 4 });
    expect(frozen?.frozenAt).not.toBeNull();
    expect(
      await store.freeze({
        preparationId: preparation.preparationId,
        fencingToken: "5",
      }),
    ).toEqual(frozen);
    expect(
      (await store.getTransitionHistory(preparation.preparationId)).map(
        (event) => [event.eventType, event.actorAgentId],
      ),
    ).toEqual([
      ["preparation_selected", null],
      ["contestant_ready", agent1Id],
      ["contestant_ready", agent2Id],
      ["preparation_frozen", null],
    ]);
  });

  it("serializes simultaneous contestant readiness without losing either audit edge", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "6",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    const [agent1Ready, agent2Ready] = await Promise.all([
      store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: "6",
        agentId: agent1Id,
        planEvidence: planEvidence(agent1Id),
      }),
      store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: "6",
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      }),
    ]);
    expect(agent1Ready).not.toBeNull();
    expect(agent2Ready).not.toBeNull();
    expect(await store.get(preparation.preparationId)).toMatchObject({
      status: "ready",
      version: 3,
      agent1ReadyAt: expect.any(Number),
      agent2ReadyAt: expect.any(Number),
    });
    const history = await store.getTransitionHistory(preparation.preparationId);
    expect(history.map((event) => event.eventType)).toEqual([
      "preparation_selected",
      "contestant_ready",
      "contestant_ready",
    ]);
    expect(
      new Set(history.slice(1).map((event) => event.actorAgentId)),
    ).toEqual(new Set([agent1Id, agent2Id]));
    expect(history.slice(1).map((event) => event.preparationVersion)).toEqual([
      2, 3,
    ]);
  });

  it("fences stale authorities and expires access on database time", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "8",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    expect(
      await store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: "7",
        agentId: agent1Id,
        planEvidence: planEvidence(agent1Id),
      }),
    ).toBeNull();

    await pool.query(
      `UPDATE streaming_duel_preparations
       SET "selectedAt" = 0, "expiresAt" = 1
       WHERE "preparationId" = $1`,
      [preparation.preparationId],
    );
    expect(
      await store.authorizeBankAccess({
        preparationId: preparation.preparationId,
        playerId: agent1Id,
        action: "open",
      }),
    ).toEqual({ ok: false, reason: "preparation_expired" });
    expect(await store.expire()).toEqual([
      expect.objectContaining({
        preparationId: preparation.preparationId,
        status: "expired",
      }),
    ]);
    expect(
      (await store.getTransitionHistory(preparation.preparationId)).map(
        (event) => [event.eventType, event.occurredAt],
      ),
    ).toEqual([
      ["preparation_selected", preparation.selectedAt],
      ["preparation_expired", 1],
    ]);
  });

  it("revalidates persisted participation atomically at public snapshot freeze", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "29",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "29",
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "29",
      agentId: agent2Id,
      planEvidence: planEvidence(agent2Id),
    });
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account2Id,
        agentId: agent2Id,
        enabled: false,
      }),
    ).toMatchObject({ status: "updated" });
    const cycleId = `participation-revalidation-${runId}`;
    await expect(
      store.freezeWithCompetitiveSnapshot({
        preparationId: preparation.preparationId,
        fencingToken: "29",
        betWindowDurationMs: 60_000,
        timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
        draft: {
          diagnostic: false,
          preparationId: preparation.preparationId,
          cycleId,
          duelId: `streaming-${cycleId}`,
          duelKey: "29".repeat(32),
          contestants: [
            snapshotContestant("agent1", agent1Id),
            snapshotContestant("agent2", agent2Id),
          ],
        },
      }),
    ).rejects.toThrow(/competitive_contestant_participation_not_enabled/u);
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account2Id,
        agentId: agent2Id,
        enabled: true,
      }),
    ).toMatchObject({ status: "updated" });
    await store.cancel({
      preparationId: preparation.preparationId,
      fencingToken: "29",
      reason: "participation_revalidation_test_complete",
    });
  });

  it("claims one frozen snapshot with a newer fence and commits terminal truth idempotently", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "30",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "30",
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "30",
      agentId: agent2Id,
      planEvidence: planEvidence(agent2Id),
    });
    const cycleId = `preparation-snapshot-integration-cycle-${runId}`;
    const frozen = await store.freezeWithCompetitiveSnapshot({
      preparationId: preparation.preparationId,
      fencingToken: "30",
      betWindowDurationMs: 60_000,
      timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
      draft: {
        diagnostic: false,
        preparationId: preparation.preparationId,
        cycleId,
        duelId: `streaming-${cycleId}`,
        duelKey: runId.replaceAll("-", "").repeat(2),
        contestants: [
          snapshotContestant("agent1", agent1Id),
          snapshotContestant("agent2", agent2Id),
        ],
      },
    });
    expect(frozen).toMatchObject({
      lifecycleStatus: "frozen",
      terminal: null,
      preparation: { status: "frozen", fencingToken: "30" },
    });
    expect(frozen?.digest).toMatch(/^[0-9a-f]{64}$/);
    let ownerMutationCalls = 0;
    expect(
      await executeOwnedAgentMutation({
        pool,
        routeAgentId: agent1Id,
        accountId: account1Id,
        mutate: async () => {
          ownerMutationCalls += 1;
        },
      }),
    ).toEqual({ status: "market_locked", characterId: agent1Id });
    expect(ownerMutationCalls).toBe(0);
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account1Id,
        agentId: agent1Id,
        enabled: false,
      }),
    ).toEqual({ status: "market_locked", characterId: agent1Id });

    const claimed = await store.claimLatestCompetitiveSnapshotForRecovery("31");
    expect(claimed).toMatchObject({
      lifecycleStatus: "frozen",
      preparation: {
        preparationId: preparation.preparationId,
        fencingToken: "31",
      },
    });
    await expect(
      store.markCompetitiveSnapshotLocked({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        lockedAt: frozen!.snapshot.betCloseTime - 1,
      }),
    ).rejects.toThrow(/lifecycle_order_invalid/);
    const locked = await store.markCompetitiveSnapshotLocked({
      preparationId: preparation.preparationId,
      fencingToken: "31",
      snapshotDigest: frozen!.digest,
      lockedAt: frozen!.snapshot.betCloseTime,
    });
    expect(locked).toMatchObject({
      lifecycleStatus: "frozen",
      lockedAt: frozen!.snapshot.betCloseTime,
      duelStartedAt: null,
      recoveredAt: null,
    });
    expect(
      await store.markCompetitiveSnapshotLocked({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        lockedAt: frozen!.snapshot.betCloseTime,
      }),
    ).toEqual(locked);
    const duelStartedAt = frozen!.snapshot.betCloseTime + 2_000;
    expect(
      await store.markCompetitiveSnapshotDuelStarted({
        preparationId: preparation.preparationId,
        fencingToken: "30",
        snapshotDigest: frozen!.digest,
        duelStartedAt,
      }),
    ).toBeNull();
    const duel = await store.markCompetitiveSnapshotDuelStarted({
      preparationId: preparation.preparationId,
      fencingToken: "31",
      snapshotDigest: frozen!.digest,
      duelStartedAt,
    });
    expect(duel).toMatchObject({
      lifecycleStatus: "frozen",
      lockedAt: frozen!.snapshot.betCloseTime,
      duelStartedAt,
      recoveredAt: null,
    });
    const terminalAt = duelStartedAt + 1_000;
    await expect(
      store.markCompetitiveSnapshotTerminal({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        terminal: {
          outcome: "win",
          winnerId: "not-a-contestant",
          winReason: "kill",
          cancellationReason: null,
          seed: "42",
          replayHash: "44".repeat(32),
          terminalAt,
        },
      }),
    ).rejects.toThrow(/invalid competitive snapshot terminal/);
    const cancellation = {
      outcome: "cancelled" as const,
      winnerId: null,
      winReason: null,
      cancellationReason: "integration_recovery_cancelled",
      seed: null,
      replayHash: null,
      terminalAt,
    };
    expect(
      await store.markCompetitiveSnapshotTerminal({
        preparationId: preparation.preparationId,
        fencingToken: "30",
        snapshotDigest: frozen!.digest,
        terminal: cancellation,
      }),
    ).toBeNull();
    const terminal = await store.markCompetitiveSnapshotTerminal({
      preparationId: preparation.preparationId,
      fencingToken: "31",
      snapshotDigest: frozen!.digest,
      terminal: cancellation,
    });
    expect(terminal).toMatchObject({
      lifecycleStatus: "terminal",
      terminal: cancellation,
    });
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account1Id,
        agentId: agent1Id,
        enabled: false,
      }),
    ).toEqual({ status: "market_locked", characterId: agent1Id });
    expect(
      await store.markCompetitiveSnapshotTerminal({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        terminal: cancellation,
      }),
    ).toEqual(terminal);
    await expect(
      store.markCompetitiveSnapshotTerminal({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        terminal: {
          ...cancellation,
          cancellationReason: "contradictory_terminal",
        },
      }),
    ).rejects.toThrow(/terminal_conflict/);
    await expect(
      store.markCompetitiveSnapshotTerminal({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        terminal: {
          ...cancellation,
          cancellationReason: "not safe for public feeds",
        },
      }),
    ).rejects.toThrow(/invalid competitive snapshot terminal/);
    const recoveredAt = terminalAt + 500;
    const recovered = await store.markCompetitiveSnapshotRecovered({
      preparationId: preparation.preparationId,
      fencingToken: "31",
      snapshotDigest: frozen!.digest,
      recoveredAt,
    });
    expect(recovered).toMatchObject({
      lifecycleStatus: "retired",
      lockedAt: frozen!.snapshot.betCloseTime,
      duelStartedAt,
      recoveredAt,
      terminal: cancellation,
    });
    expect(
      await executeOwnedAgentMutation({
        pool,
        routeAgentId: agent1Id,
        accountId: account1Id,
        mutate: async () => {
          ownerMutationCalls += 1;
          return "mutated";
        },
      }),
    ).toMatchObject({
      status: "completed",
      value: "mutated",
    });
    expect(ownerMutationCalls).toBe(1);
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account1Id,
        agentId: agent1Id,
        enabled: false,
      }),
    ).toMatchObject({
      status: "updated",
      mapping: {
        characterId: agent1Id,
        streamingDuelEnabled: false,
      },
    });
    expect(
      await updatePersistedStreamingDuelParticipation({
        pool,
        accountId: account1Id,
        agentId: agent1Id,
        enabled: true,
      }),
    ).toMatchObject({ status: "updated" });
    expect(
      await store.markCompetitiveSnapshotRecovered({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        recoveredAt,
      }),
    ).toEqual(recovered);
    await expect(
      store.markCompetitiveSnapshotRecovered({
        preparationId: preparation.preparationId,
        fencingToken: "31",
        snapshotDigest: frozen!.digest,
        recoveredAt: recoveredAt + 1,
      }),
    ).rejects.toThrow(/recovery_conflict/);
    expect(
      await store.claimLatestCompetitiveSnapshotForRecovery("32"),
    ).toBeNull();

    const history = await store.getTransitionHistory(preparation.preparationId);
    expect(history.map((event) => event.eventType)).toEqual([
      "preparation_selected",
      "contestant_ready",
      "contestant_ready",
      "competitive_snapshot_frozen",
      "authority_claimed",
      "market_locked",
      "duel_started",
      "terminal_committed",
      "recovery_committed",
    ]);
    expect(history.every((event) => event.eventSource === "runtime")).toBe(
      true,
    );
    expect(
      history.every(
        (event, index) =>
          index === 0 ||
          BigInt(event.eventSequence) >
            BigInt(history[index - 1]!.eventSequence),
      ),
    ).toBe(true);
    expect(history.slice(0, 3)).toEqual([
      expect.objectContaining({
        eventType: "preparation_selected",
        occurredAt: preparation.selectedAt,
        fencingToken: "30",
        preparationVersion: 1,
        actorAgentId: null,
        snapshotDigest: null,
      }),
      expect.objectContaining({
        eventType: "contestant_ready",
        fencingToken: "30",
        preparationVersion: 2,
        actorAgentId: agent1Id,
        snapshotDigest: null,
      }),
      expect.objectContaining({
        eventType: "contestant_ready",
        fencingToken: "30",
        preparationVersion: 3,
        actorAgentId: agent2Id,
        snapshotDigest: null,
      }),
    ]);
    expect(history.slice(3)).toEqual([
      expect.objectContaining({
        eventType: "competitive_snapshot_frozen",
        occurredAt: frozen!.snapshot.frozenAt,
        fencingToken: "30",
        preparationVersion: 4,
        cycleId,
        duelId: `streaming-${cycleId}`,
        snapshotDigest: frozen!.digest,
      }),
      expect.objectContaining({
        eventType: "authority_claimed",
        fencingToken: "31",
        preparationVersion: 5,
        snapshotDigest: frozen!.digest,
      }),
      expect.objectContaining({
        eventType: "market_locked",
        occurredAt: frozen!.snapshot.betCloseTime,
        fencingToken: "31",
        preparationVersion: 5,
      }),
      expect.objectContaining({
        eventType: "duel_started",
        occurredAt: duelStartedAt,
        fencingToken: "31",
        preparationVersion: 5,
      }),
      expect.objectContaining({
        eventType: "terminal_committed",
        occurredAt: terminalAt,
        terminalOutcome: "cancelled",
        winnerId: null,
        winReason: null,
        reason: "integration_recovery_cancelled",
        terminalSeed: null,
        replayHash: null,
      }),
      expect.objectContaining({
        eventType: "recovery_committed",
        occurredAt: recoveredAt,
        fencingToken: "31",
        preparationVersion: 5,
      }),
    ]);
    expect(Object.keys(history[0]!).sort()).toEqual(
      [
        "actorAgentId",
        "agent1Id",
        "agent2Id",
        "cycleId",
        "duelId",
        "eventKey",
        "eventSequence",
        "eventSource",
        "eventType",
        "fencingToken",
        "occurredAt",
        "preparationId",
        "preparationVersion",
        "reason",
        "replayHash",
        "snapshotDigest",
        "terminalOutcome",
        "terminalSeed",
        "winnerId",
        "winReason",
      ].sort(),
    );

    const immutableEventSequence = history[0]!.eventSequence;
    await expect(
      pool.query(
        `UPDATE streaming_duel_transition_events
         SET "eventType" = "eventType" WHERE "eventSequence" = $1::bigint`,
        [immutableEventSequence],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `DELETE FROM streaming_duel_transition_events
         WHERE "eventSequence" = $1::bigint`,
        [immutableEventSequence],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`TRUNCATE streaming_duel_transition_events`),
    ).rejects.toMatchObject({ code: "55000" });
    expect(await store.getTransitionHistory(preparation.preparationId)).toEqual(
      history,
    );
  });

  it("commits competitive aggregates atomically and idempotently with terminal truth", async () => {
    const freezeCycle = async (input: {
      fencingToken: string;
      cycleId: string;
      agent1Wins: number;
      agent1Losses: number;
      agent2Wins: number;
      agent2Losses: number;
    }) => {
      const preparation = await store.create({
        preparationId: randomUUID(),
        fencingToken: input.fencingToken,
        agent1Id,
        agent2Id,
        diagnostic: false,
        durationMs: 60_000,
        allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
      });
      await claimHostLeases(preparation);
      await store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: input.fencingToken,
        agentId: agent1Id,
        planEvidence: planEvidence(agent1Id),
      });
      await store.markReady({
        preparationId: preparation.preparationId,
        fencingToken: input.fencingToken,
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      });
      const frozen = await store.freezeWithCompetitiveSnapshot({
        preparationId: preparation.preparationId,
        fencingToken: input.fencingToken,
        betWindowDurationMs: 60_000,
        timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
        draft: {
          diagnostic: false,
          preparationId: preparation.preparationId,
          cycleId: input.cycleId,
          duelId: `streaming-${input.cycleId}`,
          duelKey: randomUUID().replaceAll("-", "").repeat(2),
          contestants: [
            {
              ...snapshotContestant("agent1", agent1Id),
              wins: input.agent1Wins,
              losses: input.agent1Losses,
            },
            {
              ...snapshotContestant("agent2", agent2Id),
              wins: input.agent2Wins,
              losses: input.agent2Losses,
            },
          ],
        },
      });
      expect(frozen).not.toBeNull();
      const locked = await store.markCompetitiveSnapshotLocked({
        preparationId: preparation.preparationId,
        fencingToken: input.fencingToken,
        snapshotDigest: frozen!.digest,
        lockedAt: frozen!.snapshot.betCloseTime,
      });
      expect(locked).toMatchObject({
        lockedAt: frozen!.snapshot.betCloseTime,
        duelStartedAt: null,
      });
      const duelStartedAt = frozen!.snapshot.betCloseTime + 1;
      const started = await store.markCompetitiveSnapshotDuelStarted({
        preparationId: preparation.preparationId,
        fencingToken: input.fencingToken,
        snapshotDigest: frozen!.digest,
        duelStartedAt,
      });
      expect(started).toMatchObject({ duelStartedAt });
      return { preparation, frozen: frozen!, duelStartedAt };
    };

    const first = await freezeCycle({
      fencingToken: "40",
      cycleId: `stats-win-${runId}`,
      agent1Wins: 4,
      agent1Losses: 1,
      agent2Wins: 2,
      agent2Losses: 5,
    });
    const observedAt = first.duelStartedAt + 1;
    await pool.query(
      `
        INSERT INTO streaming_duel_action_observations (
          "operationId", "cycleId", "duelId", sequence, "observedAt",
          "actorId", "opponentId", action, observation
        ) VALUES ($1, $2, $3, 1, $4::bigint, $5, $6, 'damage', $7::jsonb)
      `,
      [
        randomUUID(),
        first.frozen.snapshot.cycleId,
        first.frozen.snapshot.duelId,
        observedAt,
        agent1Id,
        agent2Id,
        JSON.stringify({
          schemaVersion: 1,
          sequence: 1,
          cycleId: first.frozen.snapshot.cycleId,
          duelId: first.frozen.snapshot.duelId,
          actorId: agent1Id,
          opponentId: agent2Id,
          tick: 1,
          observedAt,
          phase: "FIGHTING",
          combatRole: "melee",
          tacticalMacro: "pressure",
          action: "damage",
          value: "hit",
          amount: 7,
          outcome: "committed",
        }),
      ],
    );
    await pool.query(
      `
        INSERT INTO streaming_duel_action_observations (
          "operationId", "cycleId", "duelId", sequence, "observedAt",
          "actorId", "opponentId", action, observation
        ) VALUES
          ($1, $3, $4, 2, $5::bigint, $6, $7, 'movement', $8::jsonb),
          ($2, $3, $4, 3, $9::bigint, $7, $6, 'style', $10::jsonb)
      `,
      [
        randomUUID(),
        randomUUID(),
        first.frozen.snapshot.cycleId,
        first.frozen.snapshot.duelId,
        observedAt + 1,
        agent1Id,
        agent2Id,
        JSON.stringify({
          schemaVersion: 1,
          sequence: 2,
          cycleId: first.frozen.snapshot.cycleId,
          duelId: first.frozen.snapshot.duelId,
          actorId: agent1Id,
          opponentId: agent2Id,
          tick: 2,
          observedAt: observedAt + 1,
          phase: "FIGHTING",
          combatRole: "melee",
          tacticalMacro: "pressure",
          action: "movement",
          value: "reposition",
          amount: null,
          outcome: "accepted",
        }),
        observedAt + 2,
        JSON.stringify({
          schemaVersion: 1,
          sequence: 3,
          cycleId: first.frozen.snapshot.cycleId,
          duelId: first.frozen.snapshot.duelId,
          actorId: agent2Id,
          opponentId: agent1Id,
          tick: 3,
          observedAt: observedAt + 2,
          phase: "FIGHTING",
          combatRole: "melee",
          tacticalMacro: "pressure",
          action: "style",
          value: "aggressive",
          amount: null,
          outcome: "accepted",
        }),
      ],
    );
    const winTerminal = {
      outcome: "win" as const,
      winnerId: agent1Id,
      winReason: "kill",
      cancellationReason: null,
      seed: "50",
      replayHash: "55".repeat(32),
      terminalAt: observedAt + 3,
    };
    const committedWin = await store.markCompetitiveSnapshotTerminal({
      preparationId: first.preparation.preparationId,
      fencingToken: "40",
      snapshotDigest: first.frozen.digest,
      terminal: winTerminal,
    });
    expect(committedWin).toMatchObject({ terminal: winTerminal });
    expect(
      await store.markCompetitiveSnapshotTerminal({
        preparationId: first.preparation.preparationId,
        fencingToken: "40",
        snapshotDigest: first.frozen.digest,
        terminal: winTerminal,
      }),
    ).toEqual(committedWin);

    const afterWin = await pool.query(
      `
        SELECT combat."playerId", combat."totalDuelWins", combat."totalDuelLosses",
               agent.draws, agent."currentStreak", agent."killStreak",
               agent."totalDamageDealt", agent."totalDamageTaken"
        FROM player_combat_stats AS combat
        JOIN agent_duel_stats AS agent ON agent."characterId" = combat."playerId"
        WHERE combat."playerId" IN ($1, $2)
        ORDER BY combat."playerId"
      `,
      [agent1Id, agent2Id],
    );
    expect(afterWin.rows).toEqual([
      {
        playerId: agent1Id,
        totalDuelWins: 5,
        totalDuelLosses: 1,
        draws: 0,
        currentStreak: 1,
        killStreak: 1,
        totalDamageDealt: 7,
        totalDamageTaken: 0,
      },
      {
        playerId: agent2Id,
        totalDuelWins: 2,
        totalDuelLosses: 6,
        draws: 0,
        currentStreak: 0,
        killStreak: 0,
        totalDamageDealt: 0,
        totalDamageTaken: 7,
      },
    ]);

    const second = await freezeCycle({
      fencingToken: "41",
      cycleId: `stats-draw-${runId}`,
      agent1Wins: 5,
      agent1Losses: 1,
      agent2Wins: 2,
      agent2Losses: 6,
    });
    const drawTerminal = {
      outcome: "draw" as const,
      winnerId: null,
      winReason: "draw",
      cancellationReason: "draw",
      seed: "51",
      replayHash: "56".repeat(32),
      terminalAt: second.duelStartedAt + 1,
    };
    await store.markCompetitiveSnapshotTerminal({
      preparationId: second.preparation.preparationId,
      fencingToken: "41",
      snapshotDigest: second.frozen.digest,
      terminal: drawTerminal,
    });

    const afterDraw = await pool.query(
      `
        SELECT "characterId", wins, losses, draws, "currentStreak"
        FROM agent_duel_stats
        WHERE "characterId" IN ($1, $2)
        ORDER BY "characterId"
      `,
      [agent1Id, agent2Id],
    );
    expect(afterDraw.rows).toEqual([
      {
        characterId: agent1Id,
        wins: 5,
        losses: 1,
        draws: 1,
        currentStreak: 1,
      },
      {
        characterId: agent2Id,
        wins: 2,
        losses: 6,
        draws: 1,
        currentStreak: 0,
      },
    ]);

    const terminalRows = await pool.query(
      `SELECT
         "preparationId", "snapshotVersion", "cycleId", "duelId", "duelKey",
         "snapshotDigest", "snapshot", "frozenAt", "lockedAt", "duelStartedAt",
         "recoveredAt", "lifecycleStatus", "terminalOutcome",
         "terminalWinnerId", "terminalWinReason", "terminalCancellationReason",
         "terminalSeed", "terminalReplayHash", "terminalAt"
       FROM streaming_duel_competitive_snapshots
       WHERE "cycleId" = ANY($1::text[])
       ORDER BY "terminalAt", "cycleId"`,
      [[first.frozen.snapshot.cycleId, second.frozen.snapshot.cycleId]],
    );
    const actionRows = await pool.query(
      `SELECT
         "cycleId", "duelId", "sequence", "observedAt",
         "actorId", "opponentId", "action", "observation"
       FROM streaming_duel_action_observations
       WHERE "cycleId" = ANY($1::text[])
       ORDER BY "cycleId", sequence`,
      [[first.frozen.snapshot.cycleId, second.frozen.snapshot.cycleId]],
    );
    const strategyReport = buildCompetitiveStrategyOutcomeReport(
      terminalRows.rows,
      actionRows.rows,
    );
    expect(strategyReport).toMatchObject({
      completedDuels: 2,
      participantSamples: 4,
    });
    expect(strategyReport.samples[0].execution).toMatchObject({
      observations: 2,
      movement: { attempts: 1, accepted: 1 },
      damage: { hits: 1, total: 7 },
    });
    expect(strategyReport.samples[1].execution).toMatchObject({
      observations: 1,
      style: {
        attempts: 1,
        accepted: 1,
        acceptedByStyle: { aggressive: 1 },
      },
      damage: { hits: 0, total: 0 },
    });
    expect(
      strategyReport.samples.map((sample) => ({
        cycleId: sample.cycleId,
        agentId: sample.agentId,
        result: sample.result,
        damageDealt: sample.damageDealt,
        damageTaken: sample.damageTaken,
      })),
    ).toEqual([
      {
        cycleId: first.frozen.snapshot.cycleId,
        agentId: agent1Id,
        result: "win",
        damageDealt: 7,
        damageTaken: 0,
      },
      {
        cycleId: first.frozen.snapshot.cycleId,
        agentId: agent2Id,
        result: "loss",
        damageDealt: 0,
        damageTaken: 7,
      },
      {
        cycleId: second.frozen.snapshot.cycleId,
        agentId: agent1Id,
        result: "draw",
        damageDealt: 0,
        damageTaken: 0,
      },
      {
        cycleId: second.frozen.snapshot.cycleId,
        agentId: agent2Id,
        result: "draw",
        damageDealt: 0,
        damageTaken: 0,
      },
    ]);
  });

  it("cancels idempotently with a bounded machine-readable reason", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "9",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    const cancelled = await store.cancel({
      preparationId: preparation.preparationId,
      fencingToken: "9",
      reason: "agent_disconnected",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellationReason: "agent_disconnected",
      version: 2,
    });
    expect(
      await store.cancel({
        preparationId: preparation.preparationId,
        fencingToken: "9",
        reason: "agent_disconnected",
      }),
    ).toEqual(cancelled);
    await expect(
      store.cancel({
        preparationId: preparation.preparationId,
        fencingToken: "9",
        reason: "not safe for logs",
      }),
    ).rejects.toThrow(/invalid.*reason/i);
    expect(
      (await store.getTransitionHistory(preparation.preparationId)).map(
        (event) => [event.eventType, event.reason],
      ),
    ).toEqual([
      ["preparation_selected", null],
      ["preparation_cancelled", "agent_disconnected"],
    ]);
  });

  it("serializes concurrent selections and leaves exactly one active session", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    await Promise.all([
      store.create({
        preparationId: firstId,
        fencingToken: "10",
        agent1Id,
        agent2Id,
        diagnostic: false,
        durationMs: 60_000,
        allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
      }),
      store.create({
        preparationId: secondId,
        fencingToken: "10",
        agent1Id,
        agent2Id: agent3Id,
        diagnostic: false,
        durationMs: 60_000,
        allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
      }),
    ]);

    const [first, second, activeCount] = await Promise.all([
      store.get(firstId),
      store.get(secondId),
      pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM streaming_duel_preparations
         WHERE status IN ('preparing', 'ready')`,
      ),
    ]);
    expect([first?.status, second?.status].sort()).toEqual([
      "cancelled",
      "preparing",
    ]);
    expect(activeCount.rows[0]?.count).toBe("1");
  });

  it("serializes cancellation behind an in-flight preparation bank authority and then revokes it", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "71",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    const accessClient = await pool.connect();
    let cancellationSettled = false;
    try {
      await accessClient.query("BEGIN");
      expect(
        await authorizeDuelPreparationBankAccess(accessClient, {
          preparationId: preparation.preparationId,
          playerId: agent1Id,
          action: "withdraw",
          lockForTransaction: true,
        }),
      ).toMatchObject({ ok: true });

      const cancellationPromise = store
        .cancel({
          preparationId: preparation.preparationId,
          fencingToken: "71",
          reason: "contestant_unavailable",
        })
        .then((result) => {
          cancellationSettled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cancellationSettled).toBe(false);
      await accessClient.query("COMMIT");

      await expect(cancellationPromise).resolves.toMatchObject({
        status: "cancelled",
        cancellationReason: "contestant_unavailable",
      });
      expect(
        await store.authorizeBankAccess({
          preparationId: preparation.preparationId,
          playerId: agent1Id,
          action: "withdraw",
        }),
      ).toEqual({ ok: false, reason: "preparation_not_active" });
    } finally {
      if (!cancellationSettled) {
        await accessClient.query("ROLLBACK").catch(() => undefined);
      }
      accessClient.release();
    }
  });

  it("atomically couples the durable capability to retry-safe bank custody", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "11",
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, $2, 2, 0)`,
      [agent1Id, bankItemId],
    );
    const inventorySystem = {
      isInventoryReady: () => true,
      queueOperation: async (
        _playerId: string,
        operation: () => Promise<boolean>,
      ) => operation(),
      lockForTransaction: () => true,
      unlockTransaction: () => undefined,
      persistInventoryImmediate: async () => undefined,
      reloadFromDatabase: async () => undefined,
    };
    const world = {
      pgPool: pool,
      entities: {
        get: (id: string) =>
          id === agent1Id
            ? { data: { inStreamingDuel: false }, position: [0, 0, 0] }
            : undefined,
      },
      getSystem: (name: string) =>
        name === "inventory" ? inventorySystem : null,
    };
    const operationId = randomUUID();
    const opened = await openAuthoritativeAgentBank({
      world: world as never,
      playerId: agent1Id,
      bankId: getDuelPreparationBankId(preparation.preparationId),
      preparationId: preparation.preparationId,
    });
    expect(opened).toMatchObject({
      success: true,
      action: "open",
      bankItems: expect.any(Array),
    });
    const request = {
      world: world as never,
      playerId: agent1Id,
      bankId: getDuelPreparationBankId(preparation.preparationId),
      preparationId: preparation.preparationId,
      action: "deposit" as const,
      itemId: bankItemId,
      quantity: 1,
      operationId,
    };

    const committed = await executeAuthoritativeAgentBankTransfer(request);
    const replayed = await executeAuthoritativeAgentBankTransfer(request);
    expect(committed).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: false,
      committedQuantity: 1,
    });
    expect(replayed).toMatchObject({
      success: true,
      commitState: "committed",
      replayed: true,
      committedQuantity: 1,
    });
    const custody = await pool.query<{
      inventoryQuantity: string;
      bankQuantity: string;
      operationCount: string;
      operationPreparationId: string | null;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(quantity), 0)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $2) AS "inventoryQuantity",
         (SELECT COALESCE(SUM(quantity), 0)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $2) AS "bankQuantity",
         (SELECT count(*)::text FROM agent_bank_operations
          WHERE "operationId" = $3) AS "operationCount",
         (SELECT "preparationId" FROM agent_bank_operations
          WHERE "operationId" = $3) AS "operationPreparationId"`,
      [agent1Id, bankItemId, operationId],
    );
    expect(custody.rows[0]).toEqual({
      inventoryQuantity: "1",
      bankQuantity: "1",
      operationCount: "1",
      operationPreparationId: preparation.preparationId,
    });

    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "11",
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    const rejected = await executeAuthoritativeAgentBankTransfer({
      ...request,
      action: "withdraw",
      operationId: randomUUID(),
    });
    expect(rejected).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "preparation_agent_ready",
    });

    await store.markReady({
      preparationId: preparation.preparationId,
      fencingToken: "11",
      agentId: agent2Id,
      planEvidence: planEvidence(agent2Id),
    });
    const cycleId = `preparation-bank-audit-cycle-${runId}`;
    const frozen = await store.freezeWithCompetitiveSnapshot({
      preparationId: preparation.preparationId,
      fencingToken: "11",
      betWindowDurationMs: 60_000,
      timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
      draft: {
        diagnostic: false,
        preparationId: preparation.preparationId,
        cycleId,
        duelId: `streaming-${cycleId}`,
        duelKey: `ba${runId.replaceAll("-", "")}`.padEnd(64, "0").slice(0, 64),
        contestants: [
          snapshotContestant("agent1", agent1Id),
          snapshotContestant("agent2", agent2Id),
        ],
      },
    });
    const audit = await pool.query<{
      operationId: string;
      preparationId: string;
      cycleId: string;
      duelId: string;
      snapshotDigest: string;
      playerId: string;
      action: string;
      createdAt: string;
    }>(
      `SELECT *
       FROM streaming_duel_bank_action_audit
       WHERE "preparationId" = $1
       ORDER BY action`,
      [preparation.preparationId],
    );
    expect(audit.rows).toEqual([
      {
        operationId,
        preparationId: preparation.preparationId,
        cycleId,
        duelId: `streaming-${cycleId}`,
        snapshotDigest: frozen!.digest,
        playerId: agent1Id,
        action: "deposit",
        createdAt: expect.any(String),
      },
      {
        operationId: opened.operationId,
        preparationId: preparation.preparationId,
        cycleId,
        duelId: `streaming-${cycleId}`,
        snapshotDigest: frozen!.digest,
        playerId: agent1Id,
        action: "open",
        createdAt: expect.any(String),
      },
    ]);
    expect(Object.keys(audit.rows[0] ?? {}).sort()).toEqual(
      [
        "action",
        "createdAt",
        "cycleId",
        "duelId",
        "operationId",
        "playerId",
        "preparationId",
        "snapshotDigest",
      ].sort(),
    );

    await expect(
      pool.query(
        `INSERT INTO agent_bank_operations (
           "operationId", "playerId", action, "bankId", "preparationId",
           "itemId", "requestedQuantity", "committedQuantity",
           "inventoryQuantityAfter", "bankQuantityAfter",
           "requestFingerprint", "itemCount"
         ) VALUES ($1, $2, 'deposit', $3, $4, $5, 1, 1, 0, 1, $6, 1)`,
        [
          randomUUID(),
          agent3Id,
          getDuelPreparationBankId(preparation.preparationId),
          preparation.preparationId,
          bankItemId,
          "cd".repeat(32),
        ],
      ),
    ).rejects.toThrow(/not a preparation contestant/);
    await expect(
      pool.query(
        `INSERT INTO streaming_duel_bank_open_events
           ("operationId", "preparationId", "playerId", "bankId")
         VALUES ($1, $2, $3, $4)`,
        [
          randomUUID(),
          preparation.preparationId,
          agent3Id,
          getDuelPreparationBankId(preparation.preparationId),
        ],
      ),
    ).rejects.toThrow(/not a preparation contestant/);
    await expect(
      pool.query(
        `UPDATE streaming_duel_bank_open_events SET "createdAt" = 0
         WHERE "operationId" = $1`,
        [opened.operationId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("serializes concurrent cross-process custody transfers without duplicating items", async () => {
    const preparation = await store.create({
      preparationId: randomUUID(),
      fencingToken: "12",
      agent1Id,
      agent2Id: agent3Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    await claimHostLeases(preparation);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, $2, 1, 0)`,
      [agent3Id, bankItemId],
    );
    const inventorySystem = {
      isInventoryReady: () => true,
      queueOperation: async (
        _playerId: string,
        operation: () => Promise<boolean>,
      ) => operation(),
      // Always succeeding here intentionally models two independent server
      // processes whose in-memory locks cannot see each other.
      lockForTransaction: () => true,
      unlockTransaction: () => undefined,
      persistInventoryImmediate: async () => undefined,
      reloadFromDatabase: async () => undefined,
    };
    const world = {
      pgPool: pool,
      entities: {
        get: (id: string) =>
          id === agent3Id
            ? { data: { inStreamingDuel: false }, position: [0, 0, 0] }
            : undefined,
      },
      getSystem: (name: string) =>
        name === "inventory" ? inventorySystem : null,
    };
    const baseRequest = {
      world: world as never,
      playerId: agent3Id,
      bankId: getDuelPreparationBankId(preparation.preparationId),
      preparationId: preparation.preparationId,
      action: "deposit" as const,
      itemId: bankItemId,
      quantity: 1,
    };
    const operationIds = [randomUUID(), randomUUID()];

    const receipts = await Promise.all(
      operationIds.map((operationId) =>
        executeAuthoritativeAgentBankTransfer({
          ...baseRequest,
          operationId,
        }),
      ),
    );
    expect(receipts.filter((receipt) => receipt.success)).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.success)).toEqual([
      expect.objectContaining({
        commitState: "not_committed",
        failureReason: "item_not_owned",
      }),
    ]);

    const custody = await pool.query<{
      inventoryQuantity: string;
      bankQuantity: string;
      operationCount: string;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(quantity), 0)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $2) AS "inventoryQuantity",
         (SELECT COALESCE(SUM(quantity), 0)::text FROM bank_storage
          WHERE "playerId" = $1 AND "itemId" = $2) AS "bankQuantity",
         (SELECT count(*)::text FROM agent_bank_operations
          WHERE "operationId" = ANY($3::text[])) AS "operationCount"`,
      [agent3Id, bankItemId, operationIds],
    );
    expect(custody.rows[0]).toEqual({
      inventoryQuantity: "0",
      bankQuantity: "1",
      operationCount: "1",
    });
  });
});
