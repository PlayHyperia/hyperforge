import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { PlayerPersistenceUpdate } from "../../shared/types";
import { PlayerRepository } from "../repositories/PlayerRepository";
import { DatabaseSystem } from "../../systems/DatabaseSystem";

const PROGRESSION_VALUES: PlayerPersistenceUpdate = {
  combatLevel: 17,
  attackLevel: 2,
  strengthLevel: 3,
  defenseLevel: 4,
  constitutionLevel: 5,
  rangedLevel: 6,
  magicLevel: 7,
  woodcuttingLevel: 8,
  miningLevel: 9,
  fishingLevel: 10,
  firemakingLevel: 11,
  cookingLevel: 12,
  smithingLevel: 13,
  agilityLevel: 14,
  craftingLevel: 15,
  fletchingLevel: 16,
  runecraftingLevel: 17,
  attackXp: 2,
  strengthXp: 3,
  defenseXp: 4,
  constitutionXp: 5,
  rangedXp: 6,
  magicXp: 7,
  woodcuttingXp: 8.25,
  miningXp: 9.25,
  fishingXp: 10.25,
  firemakingXp: 11.25,
  cookingXp: 12.5,
  smithingXp: 13.5,
  agilityXp: 14,
  craftingXp: 15.5,
  fletchingXp: 16.5,
  runecraftingXp: 17.5,
};

const PROGRESSION_FIELDS = Object.keys(PROGRESSION_VALUES) as Array<
  keyof PlayerPersistenceUpdate
>;

describe("PlayerRepository generic progression monotonicity", () => {
  it("writes every generic XP and level snapshot through a database GREATEST fence", () => {
    const repository = new PlayerRepository({} as never, {} as never);
    const update = (
      repository as unknown as {
        buildUpdateData(data: PlayerPersistenceUpdate): Record<string, unknown>;
      }
    ).buildUpdateData({
      ...PROGRESSION_VALUES,
      health: 9,
      positionX: 12,
    });
    const dialect = new PgDialect();

    for (const field of PROGRESSION_FIELDS) {
      const value = update[field];
      expect(value, field).toBeTypeOf("object");
      const expression = value as { getSQL(): SQL };
      const query = dialect.sqlToQuery(expression.getSQL());
      expect(query.sql, field).toBe(
        `GREATEST("characters"."${String(field)}", $1)`,
      );
      expect(query.params, field).toEqual([PROGRESSION_VALUES[field]]);
    }

    expect(update.health).toBe(9);
    expect(update.positionX).toBe(12);
  });

  it("applies the same monotonic policy inside complete-player transactions", async () => {
    const database = new DatabaseSystem({} as never);
    const where = vi.fn(async () => undefined);
    const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
    const update = vi.fn(() => ({ set }));
    const transaction = { update };
    const internals = database as unknown as {
      db: unknown;
      executeInTransaction<T>(
        callback: (tx: typeof transaction) => Promise<T>,
      ): Promise<T>;
    };
    internals.db = {};
    internals.executeInTransaction = vi.fn(async (callback) =>
      callback(transaction),
    );

    await database.savePlayerCompleteAsync("progression-player", {
      ...PROGRESSION_VALUES,
      health: 9,
      positionX: 12,
    });

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
    const values = set.mock.calls[0]![0];
    const dialect = new PgDialect();
    for (const field of PROGRESSION_FIELDS) {
      const expression = values[field] as { getSQL(): SQL };
      const query = dialect.sqlToQuery(expression.getSQL());
      expect(query.sql, field).toBe(
        `GREATEST("characters"."${String(field)}", $1)`,
      );
      expect(query.params, field).toEqual([PROGRESSION_VALUES[field]]);
    }
    expect(values.health).toBe(9);
    expect(values.positionX).toBe(12);
  });
});
