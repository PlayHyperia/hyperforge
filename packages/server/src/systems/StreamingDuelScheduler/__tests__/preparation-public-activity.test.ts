import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../database/schema.js";
import { PostgresDuelPreparationStore } from "../preparation.js";

const preparationId = "1d7e783c-2e49-42ce-9d92-fb66af41908b";
const ownerId = "6116ca3a-98df-4a62-a77e-1c7bc3b13ed1";

describe("durable public preparation activity", () => {
  it("ships an append-only, contestant-bound, category-only migration", () => {
    const migration = readFileSync(
      new URL(
        "../../../database/migrations/0099_add_duel_preparation_public_activities.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(schema.streamingDuelPreparationPublicActivities).toBeDefined();
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_public_activities"',
    );
    expect(migration).toContain(
      "public preparation activity agent is not a contestant",
    );
    expect(migration).toContain(
      "public preparation activity has no active contestant host lease",
    );
    expect(migration).toContain(
      "public preparation activity records are append-only",
    );
    const tableDefinition = migration.slice(
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_public_activities"',
      ),
      migration.indexOf(");", migration.indexOf("CREATE TABLE")) + 2,
    );
    expect(tableDefinition).not.toMatch(
      /itemId|quantity|targetId|route|prompt|bankItems|inventory|wallet/iu,
    );
  });

  it("commits before returning the database revision and timestamp", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM streaming_duel_preparations AS preparation")) {
        return {
          rows: [
            {
              agent1Id: "agent-alpha",
              agent2Id: "agent-beta",
              status: "preparing",
              expiresAt: 2_000,
              databaseNow: 1_000,
              hostLeaseActive: true,
            },
          ],
        };
      }
      if (sql.includes('ORDER BY "activitySequence" DESC')) {
        return { rows: [] };
      }
      if (
        sql.includes("INSERT INTO streaming_duel_preparation_public_activities")
      ) {
        return {
          rows: [
            {
              activitySequence: "41",
              preparationId,
              agentId: "agent-alpha",
              activity: "planning",
              mode: "working",
              occurredAt: "1001",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PostgresDuelPreparationStore({
      connect: async () => ({ query, release }),
      query: vi.fn(),
    } as never);

    await expect(
      store.appendPublicActivity({
        preparationId,
        agentId: "agent-alpha",
        ownerId,
        activity: "planning",
        mode: "working",
      }),
    ).resolves.toEqual({
      preparationId,
      agentId: "agent-alpha",
      activity: "planning",
      mode: "working",
      occurredAt: 1001,
      revision: 41,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE OF preparation"),
      expect.stringContaining('ORDER BY "activitySequence" DESC'),
      expect.stringContaining(
        "INSERT INTO streaming_duel_preparation_public_activities",
      ),
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed without the exact active host lease", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      return {
        rows: [
          {
            agent1Id: "agent-alpha",
            agent2Id: "agent-beta",
            status: "preparing",
            expiresAt: 2_000,
            databaseNow: 1_000,
            hostLeaseActive: false,
          },
        ],
      };
    });
    const store = new PostgresDuelPreparationStore({
      connect: async () => ({ query, release }),
      query: vi.fn(),
    } as never);

    await expect(
      store.appendPublicActivity({
        preparationId,
        agentId: "agent-alpha",
        ownerId,
        activity: "gathering",
        mode: "traveling",
      }),
    ).rejects.toThrow("duel_preparation_public_activity_not_authorized");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("loads only a bounded ordered tail and rejects private-shaped rows", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          activitySequence: "7",
          preparationId,
          agentId: "agent-alpha",
          activity: "gathering",
          mode: "traveling",
          occurredAt: "1200",
        },
        {
          activitySequence: "9",
          preparationId,
          agentId: "agent-beta",
          activity: "provisioning",
          mode: "working",
          occurredAt: "1300",
        },
      ],
    }));
    const store = new PostgresDuelPreparationStore({
      connect: vi.fn(),
      query,
    } as never);
    await expect(
      store.listRecentPublicActivities(preparationId, 4),
    ).resolves.toEqual([
      {
        preparationId,
        agentId: "agent-alpha",
        activity: "gathering",
        mode: "traveling",
        occurredAt: 1200,
        revision: 7,
      },
      {
        preparationId,
        agentId: "agent-beta",
        activity: "provisioning",
        mode: "working",
        occurredAt: 1300,
        revision: 9,
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("row_number() OVER"),
      [preparationId, 4],
    );

    query.mockResolvedValueOnce({
      rows: [
        {
          activitySequence: "10",
          preparationId,
          agentId: "agent-alpha",
          activity: "private loadout: sword",
          mode: "working",
          occurredAt: "1400",
        },
      ],
    });
    await expect(
      store.listRecentPublicActivities(preparationId),
    ).rejects.toThrow("invalid durable public preparation activity");
  });
});
