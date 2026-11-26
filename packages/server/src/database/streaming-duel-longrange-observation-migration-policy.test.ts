import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "./migrations/0106_allow_longrange_duel_style_observations.sql",
    import.meta.url,
  ),
  "utf8",
);
const previousMigration = readFileSync(
  new URL(
    "./migrations/0088_allow_zero_effect_committed_duel_food_observations.sql",
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

describe("public longrange duel-style migration policy", () => {
  it("changes only the exact style allowlist in the trigger authority", () => {
    const previousBodyStart = previousMigration.indexOf(
      "CREATE OR REPLACE FUNCTION",
    );
    const expected = previousMigration
      .slice(previousBodyStart)
      .replace(
        "'accurate', 'aggressive', 'controlled', 'defensive', 'rapid'",
        "'accurate', 'aggressive', 'controlled', 'defensive', 'longrange',\n        'rapid'",
      );
    const bodyStart = migration.indexOf("CREATE OR REPLACE FUNCTION");
    expect(previousBodyStart).toBeGreaterThan(0);
    expect(bodyStart).toBeGreaterThan(0);
    expect(migration.slice(bodyStart).trim()).toBe(expected.trim());
    expect(migration).toContain("CREATE OR REPLACE FUNCTION");
    expect(migration).toContain("'defensive', 'longrange'");
    expect(migration).not.toContain("DROP TRIGGER");
  });

  it("is monotonic at its journal position and retains a unique journal", () => {
    expect(journal.entries.find((entry) => entry.idx === 106)).toEqual({
      idx: 106,
      version: "7",
      when: 1_788_120_000_000,
      tag: "0106_allow_longrange_duel_style_observations",
      breakpoints: true,
    });
    const indexes = journal.entries.map((entry) => entry.idx);
    expect(new Set(indexes).size).toBe(indexes.length);
    const position = indexes.indexOf(106);
    expect(indexes[position - 1]).toBe(105);
    expect(indexes[position + 1]).toBe(107);
    expect(journal.entries[position - 1]!.when).toBeLessThan(
      journal.entries[position]!.when,
    );
    expect(journal.entries[position]!.when).toBeLessThan(
      journal.entries[position + 1]!.when,
    );
  });
});
