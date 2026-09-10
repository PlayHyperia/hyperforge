import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { prayerStateFingerprint } from "../prayer-operation-receipt";
import {
  runPrayerReceiptCompaction,
  type PrayerReceiptCompactionMode,
} from "../prayer-receipt-compaction";
import { parsePrayerReceiptCompactionCliArgs } from "../prayer-receipt-compaction-cli";

const operationId = "818feea4-4d27-4d3e-8f35-d79561b1b1c1";
const databaseRoot = fileURLToPath(new URL("..", import.meta.url));
const playerId = "compaction-player";
const expected = {
  pointUnits: 20_000_000,
  maxPoints: 20,
  activePrayers: ["hawk_eye"],
};
const committed = {
  pointUnits: 19_900_000,
  maxPoints: 20,
  activePrayers: ["hawk_eye"],
};
const operationState = {
  version: 1 as const,
  requestFingerprint: prayerStateFingerprint(
    playerId,
    "drain",
    expected,
    committed,
  ),
  transition: "drain" as const,
  expected,
  committed,
};
const publicExpected = {
  pointUnits: 20_000_000,
  maxPoints: 20,
  activePrayers: [] as string[],
};
const publicCommitted = {
  ...publicExpected,
  activePrayers: ["hawk_eye"],
};
const publicActionObservation = {
  operationId: "0a15d15c-0843-4f2e-b328-788ebcaabafd",
  tick: 20,
  observedAt: 2_000,
  cycleId: "cycle-compaction",
  duelId: "duel-compaction",
  actorId: playerId,
  opponentId: "compaction-opponent",
  phase: "FIGHTING" as const,
  combatRole: "ranged" as const,
  tacticalMacro: "kite" as const,
  prayer: "hawk_eye" as const,
};
const publicOperationState = {
  version: 1 as const,
  requestFingerprint: prayerStateFingerprint(
    playerId,
    "toggle",
    publicExpected,
    publicCommitted,
    publicActionObservation,
  ),
  transition: "toggle" as const,
  expected: publicExpected,
  committed: publicCommitted,
  publicActionObservation,
};
const publicStoredObservation = {
  schemaVersion: 1 as const,
  sequence: 1,
  tick: publicActionObservation.tick,
  observedAt: publicActionObservation.observedAt,
  cycleId: publicActionObservation.cycleId,
  duelId: publicActionObservation.duelId,
  actorId: publicActionObservation.actorId,
  opponentId: publicActionObservation.opponentId,
  phase: publicActionObservation.phase,
  combatRole: publicActionObservation.combatRole,
  tacticalMacro: publicActionObservation.tacticalMacro,
  action: "prayer" as const,
  outcome: "committed" as const,
  value: publicActionObservation.prayer,
  amount: null,
};

function makePool(
  mode: PrayerReceiptCompactionMode,
  overrides: Partial<{
    operationState: unknown;
    observation: unknown;
    deleteRowCount: number;
  }> = {},
) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    if (text.includes("FROM streaming_duel_action_observations")) {
      return {
        rows:
          overrides.observation === null
            ? []
            : [{ observation: overrides.observation }],
        rowCount: overrides.observation === null ? 0 : 1,
      };
    }
    if (text.includes("COUNT(*)::text")) {
      return { rows: [{ count: "1" }], rowCount: 1 };
    }
    if (text.includes("FROM operations_log AS operation")) {
      return {
        rows: [
          {
            operationId,
            playerId,
            operationState: overrides.operationState ?? operationState,
            operationTimestamp: "1000",
            completedAt: "2000",
            operationStateBytes: "512",
          },
        ],
        rowCount: 1,
      };
    }
    if (text.startsWith("DELETE FROM operations_log")) {
      return { rows: [], rowCount: overrides.deleteRowCount ?? 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = {
    connect: async () => ({ query, release }),
  } as unknown as Pick<Pool, "connect">;
  return { pool, queries, query, release, mode };
}

describe("prayer receipt compaction", () => {
  it("audits valid candidates without mutation or an invented approval", async () => {
    const harness = makePool("audit");
    const result = await runPrayerReceiptCompaction(harness.pool, {
      mode: "audit",
      cutoffBeforeMs: 3_000,
      batchLimit: 10,
      statementTimeoutMs: 1_000,
      nowMs: 4_000,
      compactionBatchId: "706d72b8-d903-4e8d-8230-e37674850857",
    });

    expect(result).toMatchObject({
      mode: "audit",
      eligibleCount: 1,
      selectedCount: 1,
      compactedCount: 0,
      selectedOperationStateBytes: 512,
      retentionApprovalId: null,
      compactionBatchId: null,
      semanticIdentityRetained: true,
      publicObservationsRetained: true,
    });
    expect(
      harness.queries.some(({ text }) =>
        text.includes("INSERT INTO compacted_prayer_state_receipts"),
      ),
    ).toBe(false);
    expect(
      harness.queries.some(({ text }) =>
        text.startsWith("DELETE FROM operations_log"),
      ),
    ).toBe(false);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("atomically archives exact identity before deleting the full WAL body", async () => {
    const harness = makePool("execute");
    const result = await runPrayerReceiptCompaction(harness.pool, {
      mode: "execute",
      cutoffBeforeMs: 3_000,
      batchLimit: 10,
      statementTimeoutMs: 1_000,
      retentionApprovalId: "ops-approved-retention-42",
      nowMs: 4_000,
      compactionBatchId: "706d72b8-d903-4e8d-8230-e37674850857",
    });

    expect(result.compactedCount).toBe(1);
    const insert = harness.queries.find(({ text }) =>
      text.includes("INSERT INTO compacted_prayer_state_receipts"),
    );
    const deletion = harness.queries.findIndex(({ text }) =>
      text.startsWith("DELETE FROM operations_log"),
    );
    expect(insert?.values).toEqual([
      operationId,
      playerId,
      operationState.requestFingerprint,
      "drain",
      null,
      "ops-approved-retention-42",
      "706d72b8-d903-4e8d-8230-e37674850857",
      1_000,
      2_000,
      4_000,
    ]);
    expect(deletion).toBeGreaterThan(
      harness.queries.findIndex(({ text }) =>
        text.includes("INSERT INTO compacted_prayer_state_receipts"),
      ),
    );
    expect(harness.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("retains and verifies the exact separate public observation identity", async () => {
    const harness = makePool("execute", {
      operationState: publicOperationState,
      observation: publicStoredObservation,
    });
    await expect(
      runPrayerReceiptCompaction(harness.pool, {
        mode: "execute",
        cutoffBeforeMs: 3_000,
        batchLimit: 10,
        statementTimeoutMs: 1_000,
        retentionApprovalId: "ops-approved-retention-42",
        nowMs: 4_000,
        compactionBatchId: "706d72b8-d903-4e8d-8230-e37674850857",
      }),
    ).resolves.toMatchObject({ compactedCount: 1 });
    const insert = harness.queries.find(({ text }) =>
      text.includes("INSERT INTO compacted_prayer_state_receipts"),
    );
    expect(insert?.values?.[4]).toBe(publicActionObservation.operationId);
  });

  it("rolls back if public observation custody disagrees with the receipt", async () => {
    const harness = makePool("execute", {
      operationState: publicOperationState,
      observation: null,
    });
    await expect(
      runPrayerReceiptCompaction(harness.pool, {
        mode: "execute",
        cutoffBeforeMs: 3_000,
        batchLimit: 10,
        statementTimeoutMs: 1_000,
        retentionApprovalId: "ops-approved-retention-42",
        nowMs: 4_000,
        compactionBatchId: "706d72b8-d903-4e8d-8230-e37674850857",
      }),
    ).rejects.toThrow("prayer_receipt_compaction_observation_mismatch");
    expect(harness.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires an explicit cutoff and approval for execution", async () => {
    const harness = makePool("execute");
    await expect(
      runPrayerReceiptCompaction(harness.pool, {
        mode: "execute",
        cutoffBeforeMs: 3_000,
        batchLimit: 10,
        statementTimeoutMs: 1_000,
        nowMs: 4_000,
      }),
    ).rejects.toThrow("prayer_receipt_compaction_approval_required");
    expect(harness.query).not.toHaveBeenCalled();
  });

  it("parses only the exact audit CLI argument set", () => {
    const options = parsePrayerReceiptCompactionCliArgs([
      "bun",
      "prayer-receipt-compaction-cli.ts",
      "audit",
      "--database-url=postgres://operator:secret@db.example/hyperia",
      "--cutoff-before-ms=1788076800000",
      "--batch-limit=250",
      "--statement-timeout-ms=5000",
      "--connection-timeout-ms=3000",
    ]);
    expect(options.request).toEqual({
      mode: "audit",
      cutoffBeforeMs: 1_788_076_800_000,
      batchLimit: 250,
      statementTimeoutMs: 5_000,
    });
    expect(() =>
      parsePrayerReceiptCompactionCliArgs([
        "bun",
        "prayer-receipt-compaction-cli.ts",
        "execute",
        "--database-url=postgres://db.example/hyperia",
        "--cutoff-before-ms=1788076800000",
        "--batch-limit=250",
        "--statement-timeout-ms=5000",
        "--connection-timeout-ms=3000",
      ]),
    ).toThrow("prayer_receipt_compaction_argument_set_incomplete");
  });

  it("keeps compact identities append-only and blocks global operation-ID reuse", () => {
    const migration = readFileSync(
      `${databaseRoot}/migrations/0094_add_compacted_prayer_state_receipts.sql`,
      "utf8",
    );
    const databaseSystem = readFileSync(
      `${databaseRoot}/../systems/DatabaseSystem/index.ts`,
      "utf8",
    );
    expect(migration).toContain(
      "compacted_prayer_state_receipts_reject_mutation",
    );
    expect(migration).toContain(
      "compacted_prayer_state_receipts_reject_truncate",
    );
    expect(migration).toContain(
      "operations_log_reject_compacted_prayer_id_reuse",
    );
    expect(migration).not.toMatch(/INTERVAL\s+'?\d+\s+(day|hour)/iu);
    const prayerMethodStart = databaseSystem.indexOf(
      "async commitPrayerStateOperationAsync",
    );
    const prayerMethod = databaseSystem.slice(
      prayerMethodStart,
      prayerMethodStart + 16_000,
    );
    expect(prayerMethodStart).toBeGreaterThan(0);
    expect(prayerMethod.indexOf("compactedPrayerStateReceipts")).toBeLessThan(
      prayerMethod.indexOf("const existingRows = await tx"),
    );
  });
});
