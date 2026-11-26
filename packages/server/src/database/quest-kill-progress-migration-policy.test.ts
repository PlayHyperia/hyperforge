import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HYPERIA_RECOVERY_TABLES } from "./hyperia-postgres-backup.js";
import * as schema from "./schema.js";

const migration = readFileSync(
  new URL(
    "./migrations/0104_add_durable_quest_kill_progress.sql",
    import.meta.url,
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(
    new URL("./migrations/meta/_journal.json", import.meta.url),
    "utf8",
  ),
) as {
  entries: Array<{
    idx: number;
    version: string;
    tag: string;
    breakpoints: boolean;
  }>;
};

describe("durable quest-kill migration policy", () => {
  it("binds every receipt to committed mob-loot custody and one quest incarnation", () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS "quest_kill_progress_receipts"/u,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("operation_id"\) REFERENCES "public"\."operations_log"\("id"\)\s+ON DELETE RESTRICT/u,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("player_id"\) REFERENCES "public"\."characters"\("id"\)\s+ON DELETE CASCADE/u,
    );
    expect(migration).toContain('"quantity" = 1');
    expect(migration).toContain("\"resolution\" IN ('retired', 'ignored')");
    expect(migration).toMatch(
      /UNIQUE INDEX IF NOT EXISTS "quest_kill_progress_receipts_operation_quest_unique"/u,
    );
    expect(migration).toMatch(/"player_id", "quest_id", "quest_started_at"/u);
  });

  it("keeps schema, migration journal, and recovery coverage synchronized", () => {
    expect(schema.questKillProgressReceipts).toBeDefined();
    expect(HYPERIA_RECOVERY_TABLES).toContain("quest_kill_progress_receipts");
    expect(journal.entries.find((entry) => entry.idx === 104)).toEqual({
      idx: 104,
      version: "7",
      when: 1_788_112_800_000,
      tag: "0104_add_durable_quest_kill_progress",
      breakpoints: true,
    });
    const indexes = journal.entries.map((entry) => entry.idx);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(
      indexes.every(
        (value, index) => index === 0 || value > indexes[index - 1]!,
      ),
    ).toBe(true);
    expect(indexes.at(-1)).toBe(indexes.at(-2)! + 1);
  });
});
