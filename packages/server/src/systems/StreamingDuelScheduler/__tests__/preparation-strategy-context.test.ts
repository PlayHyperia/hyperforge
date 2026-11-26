import { readFileSync } from "node:fs";
import {
  DUEL_PREPARATION_ROLE_POLICY_VERSION,
  EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
} from "@hyperforge/shared";
import { describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import {
  PostgresDuelPreparationStore,
  type DuelPreparationStrategyContext,
} from "../preparation.js";

const preparationId = "83f5a9ce-160e-4bbf-830e-88b86da6ec73";
const hostOwnerId = "9d527ad5-b589-41b7-b167-d258597cd4fa";
const ownPublicProfile = {
  narrative: "Patient adaptive fighter.",
  pillars: ["spacing", "resource control"],
};
const opponentPublicProfile = {
  narrative: "Aggressive ranged fighter.",
  pillars: ["pressure"],
};
const opponentHistorySummary = {
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
};
const input: Omit<DuelPreparationStrategyContext, "boundAt"> = {
  preparationId,
  agentId: "agent-alpha",
  hostOwnerId,
  policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
  protocolVersion: EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
  agentName: "Agent Alpha",
  opponentName: "Agent Beta",
  ownPublicProfile,
  opponentPublicProfile,
  opponentHistorySummary,
};

const persistedRow = {
  ...input,
  ownPublicProfile: {
    narrative: ownPublicProfile.narrative,
    pillars: [...ownPublicProfile.pillars],
  },
  opponentPublicProfile: {
    narrative: opponentPublicProfile.narrative,
    pillars: [...opponentPublicProfile.pillars],
  },
  opponentHistorySummary: {
    ...opponentHistorySummary,
    recent: opponentHistorySummary.recent.map((entry) => ({ ...entry })),
  },
  boundAt: "1788098400123",
};

describe("durable external preparation strategy context", () => {
  it("ships one append-only, exact-host-bound, public-only migration", () => {
    const migration = readFileSync(
      new URL(
        "../../../database/migrations/0100_add_duel_preparation_strategy_contexts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const currentContractMigration = readFileSync(
      new URL(
        "../../../database/migrations/0102_bind_duel_preparation_opponent_history_summary.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(schema.streamingDuelPreparationStrategyContexts).toBeDefined();
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_strategy_contexts"',
    );
    expect(migration).toContain('lease."ownerId" = NEW."hostOwnerId"');
    expect(migration).toContain(
      "duel preparation strategy contexts are append-only",
    );
    expect(migration).toContain(
      `"policyVersion" = '${DUEL_PREPARATION_ROLE_POLICY_VERSION}'`,
    );
    expect(currentContractMigration).toContain(
      `NEW."protocolVersion" <> '${EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION}'`,
    );
    expect(currentContractMigration).toContain("privacy-safe matchup summary");
    expect(currentContractMigration).toContain("WITH ORDINALITY");
    expect(currentContractMigration).toContain(
      "strategy context history focus is not canonical",
    );
    expect(currentContractMigration).not.toMatch(
      /cycleId|finishedAt|ownDamage|opponentDamage|itemId|quantity|bankItems|inventory|wallet|prompt|decision/iu,
    );
    const tableDefinition = migration.slice(
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_strategy_contexts"',
      ),
      migration.indexOf(");", migration.indexOf("CREATE TABLE")) + 2,
    );
    expect(tableDefinition).not.toMatch(
      /itemId|quantity|route|prompt|bankItems|inventory|wallet|decision/iu,
    );
  });

  it("commits one canonical context before returning its database timestamp", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (
        sql.includes("INSERT INTO streaming_duel_preparation_strategy_contexts")
      ) {
        return { rows: [persistedRow] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PostgresDuelPreparationStore({
      connect: async () => ({ query, release }),
      query: vi.fn(),
    } as never);

    await expect(store.bindStrategyContext(input)).resolves.toEqual({
      ...persistedRow,
      boundAt: 1_788_098_400_123,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining(
        "INSERT INTO streaming_duel_preparation_strategy_contexts",
      ),
      "COMMIT",
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      preparationId,
      "agent-alpha",
      hostOwnerId,
      DUEL_PREPARATION_ROLE_POLICY_VERSION,
      EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
      "Agent Alpha",
      "Agent Beta",
      JSON.stringify(input.ownPublicProfile),
      JSON.stringify(input.opponentPublicProfile),
      JSON.stringify(input.opponentHistorySummary),
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("replays only an identical immutable binding and rejects drift", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (
        sql.includes("INSERT INTO streaming_duel_preparation_strategy_contexts")
      ) {
        return { rows: [] };
      }
      if (sql.includes("FROM streaming_duel_preparation_strategy_contexts")) {
        return { rows: [persistedRow] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PostgresDuelPreparationStore({
      connect: async () => ({ query, release }),
      query: vi.fn(),
    } as never);

    await expect(store.bindStrategyContext(input)).resolves.toMatchObject({
      preparationId,
      agentId: "agent-alpha",
      boundAt: 1_788_098_400_123,
    });
    await expect(
      store.bindStrategyContext({ ...input, opponentName: "Changed Name" }),
    ).rejects.toThrow("duel_preparation_strategy_context_conflict");
    await expect(
      store.bindStrategyContext({
        ...input,
        opponentHistorySummary: {
          sampleSize: 0,
          observedOpponentOpeningStyleFocus: null,
          recent: [],
        },
      }),
    ).rejects.toThrow("duel_preparation_strategy_context_conflict");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO"),
      expect.stringContaining("SELECT"),
      "COMMIT",
      "BEGIN",
      expect.stringContaining("INSERT INTO"),
      expect.stringContaining("SELECT"),
      "ROLLBACK",
      "BEGIN",
      expect.stringContaining("INSERT INTO"),
      expect.stringContaining("SELECT"),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("rejects noncanonical input and malformed persisted public profiles", async () => {
    const connect = vi.fn();
    const store = new PostgresDuelPreparationStore({
      connect,
      query: vi.fn(),
    } as never);
    await expect(
      store.bindStrategyContext({
        ...input,
        ownPublicProfile: {
          ...input.ownPublicProfile,
          privateBank: true,
        },
      } as never),
    ).rejects.toThrow("invalid duel preparation strategy context input");
    await expect(
      store.bindStrategyContext({
        ...input,
        opponentHistorySummary: {
          ...input.opponentHistorySummary,
          observedOpponentOpeningStyleFocus: "mage",
        },
      }),
    ).rejects.toThrow("invalid duel preparation strategy context input");
    await expect(
      store.bindStrategyContext({
        ...input,
        opponentHistorySummary: {
          ...input.opponentHistorySummary,
          recent: [
            {
              ...input.opponentHistorySummary.recent[0],
              cycleId: "must-not-persist",
            },
          ],
        },
      } as never),
    ).rejects.toThrow("invalid duel preparation strategy context input");
    expect(connect).not.toHaveBeenCalled();

    const release = vi.fn();
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      return {
        rows: [
          {
            ...persistedRow,
            ownPublicProfile: {
              ...persistedRow.ownPublicProfile,
              extra: "not canonical",
            },
          },
        ],
      };
    });
    const malformedStore = new PostgresDuelPreparationStore({
      connect: async () => ({ query, release }),
      query: vi.fn(),
    } as never);
    await expect(malformedStore.bindStrategyContext(input)).rejects.toThrow(
      "invalid durable duel preparation strategy context",
    );
    expect(release).toHaveBeenCalledOnce();

    const malformedHistoryQuery = vi.fn(
      async (sql: string, _values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        return {
          rows: [
            {
              ...persistedRow,
              opponentHistorySummary: {
                ...persistedRow.opponentHistorySummary,
                observedOpponentOpeningStyleFocus: "mage",
              },
            },
          ],
        };
      },
    );
    const malformedHistoryStore = new PostgresDuelPreparationStore({
      connect: async () => ({
        query: malformedHistoryQuery,
        release: vi.fn(),
      }),
      query: vi.fn(),
    } as never);
    await expect(
      malformedHistoryStore.bindStrategyContext(input),
    ).rejects.toThrow("invalid durable duel preparation strategy context");
  });
});
