import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HYPERIA_RECOVERY_TABLES } from "./hyperia-postgres-backup.js";
import * as schema from "./schema.js";

const migration = readFileSync(
  new URL(
    "./migrations/0105_add_streaming_duel_action_observation_heads.sql",
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
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

describe("streaming-duel action-observation head migration policy", () => {
  it("adds and backfills the per-cycle MVCC sequence allocator", () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS "streaming_duel_action_observation_heads"/u,
    );
    expect(migration).toContain("PRIMARY KEY NOT NULL");
    expect(migration).toContain('"lastSequence" >= 1');
    expect(migration).toMatch(
      /SELECT "cycleId", max\("sequence"\)::integer\s+FROM "streaming_duel_action_observations"\s+GROUP BY "cycleId"/u,
    );
    expect(migration).toContain("ON CONFLICT");
    expect(migration).toContain("GREATEST(");
  });

  it("keeps schema, migration journal, recovery, and container gates synchronized", () => {
    expect(schema.streamingDuelActionObservationHeads).toBeDefined();
    expect(HYPERIA_RECOVERY_TABLES).toContain(
      "streaming_duel_action_observation_heads",
    );
    expect(journal.entries.find((entry) => entry.idx === 105)).toEqual({
      idx: 105,
      version: "7",
      when: 1_788_116_400_000,
      tag: "0105_add_streaming_duel_action_observation_heads",
      breakpoints: true,
    });
    const indexes = journal.entries.map((entry) => entry.idx);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(indexes.at(-1)).toBe(indexes.at(-2)! + 1);
  });
});
