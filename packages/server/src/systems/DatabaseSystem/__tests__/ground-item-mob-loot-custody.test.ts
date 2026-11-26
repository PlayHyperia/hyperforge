import { createHash, randomUUID } from "node:crypto";

import {
  ITEMS,
  generateKillToken,
  serializeGroundItemMobLootCommitFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
} from "@hyperforge/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../database/schema.js";
import type {
  GroundItemMobLootCommitRequest,
  GroundItemSourceRegistrationRequest,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const NOW = 1_788_087_600_000;
const KILLER_ID = "mob-loot-custody-agent";
const SECRET = "mob-loot-custody-regression-secret";
const priorAirRune = ITEMS.get("air_rune");
const priorMindRune = ITEMS.get("mind_rune");

beforeAll(() => {
  process.env.KILL_TOKEN_SECRET = SECRET;
  ITEMS.set("air_rune", {
    id: "air_rune",
    name: "Air rune",
    type: "resource",
    stackable: true,
  } as never);
  ITEMS.set("mind_rune", {
    id: "mind_rune",
    name: "Mind rune",
    type: "resource",
    stackable: true,
  } as never);
});

afterAll(() => {
  delete process.env.KILL_TOKEN_SECRET;
  if (priorAirRune) ITEMS.set("air_rune", priorAirRune);
  else ITEMS.delete("air_rune");
  if (priorMindRune) ITEMS.set("mind_rune", priorMindRune);
  else ITEMS.delete("mind_rune");
});

function sourceRequest(
  itemId: string,
  quantity: number,
  x: number,
): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: `ground_item_${randomUUID()}`,
      itemId,
      quantity,
      stackable: true,
      position: { x: x + 0.5, y: 0.2, z: 15.5 },
      tile: { x, z: 15 },
      droppedBy: KILLER_ID,
      lifetimeMs: 120_000,
      lootProtectionMs: 60_000,
      allowMerge: false,
    };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemSourceRegistrationFingerprint(input), "utf8")
      .digest("hex"),
  };
}

async function request(
  sources = [
    sourceRequest("air_rune", 5, 12),
    sourceRequest("mind_rune", 2, 13),
  ],
  combat: { attackStyle: string; damageDealt: number } = {
    attackStyle: "aggressive",
    damageDealt: 20,
  },
): Promise<GroundItemMobLootCommitRequest> {
  const operationId = `ground-item-mob-loot:${randomUUID()}`;
  const deathTimestamp = NOW - 1_000;
  const { attackStyle, damageDealt } = combat;
  const identity = {
    operationId,
    killedBy: KILLER_ID,
    mobId: "mob-life-1",
    mobType: "guard",
    deathTimestamp,
    position: { x: 12.5, y: 0.2, z: 15.5 },
    killToken: await generateKillToken(
      "mob-life-1",
      KILLER_ID,
      deathTimestamp,
      operationId,
      attackStyle,
      damageDealt,
    ),
    attackStyle,
    damageDealt,
  };
  return {
    ...identity,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemMobLootCommitFingerprint(identity), "utf8")
      .digest("hex"),
    sources,
  };
}

function sourceRow(
  source: GroundItemSourceRegistrationRequest,
): Record<string, unknown> {
  return {
    source_id: source.preferredSourceId,
    status: "active",
    item_id: source.itemId,
    quantity: source.quantity,
    stackable: source.stackable,
    position_x: source.position.x,
    position_y: source.position.y,
    position_z: source.position.z,
    tile_x: source.tile.x,
    tile_z: source.tile.z,
    dropped_by: KILLER_ID,
    created_at: NOW,
    updated_at: NOW,
    expires_at: NOW + source.lifetimeMs,
    loot_protection_expires_at: NOW + source.lootProtectionMs,
    claimed_by_operation_id: null,
    claimed_by_player_id: null,
    claimed_at: null,
    version: 1,
    request_fingerprint: source.requestFingerprint,
    contribution_item_id: source.itemId,
    contribution_quantity: source.quantity,
  };
}

type FixtureOptions = {
  existingOperation?: Record<string, unknown>;
  replaySources?: GroundItemSourceRegistrationRequest[];
  activeQuests?: Array<{
    questId: string;
    currentStage: string;
    startedAt: number;
  }>;
};

function createFixture(options: FixtureOptions = {}) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];
  let executeCount = 0;
  let replaySourceIndex = 0;
  const tx = {
    execute: vi.fn(async () => {
      executeCount++;
      const sourceStep = executeCount - 2;
      if (sourceStep > 0 && sourceStep % 3 === 2) {
        return { rows: [{ databaseNow: NOW }] };
      }
      if (options.replaySources && sourceStep > 0 && sourceStep % 3 === 0) {
        return {
          rows: [sourceRow(options.replaySources[replaySourceIndex++]!)],
        };
      }
      if (executeCount === 3 && !options.replaySources) {
        return { rows: [{ databaseNow: NOW }] };
      }
      return { rows: [] };
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: vi.fn(async () => {
          if (table === schema.characters) {
            return [
              {
                id: KILLER_ID,
                attackXp: 0,
                attackLevel: 1,
                strengthXp: options.existingOperation ? 80 : 0,
                strengthLevel: 1,
                defenseXp: 0,
                defenseLevel: 1,
                constitutionXp: options.existingOperation ? 1_180 : 1_154,
                constitutionLevel: 10,
                rangedXp: 0,
                rangedLevel: 1,
                magicXp: 0,
                magicLevel: 1,
              },
            ];
          }
          if (table === schema.operationsLog) {
            return options.existingOperation ? [options.existingOperation] : [];
          }
          if (table === schema.questProgress) {
            return options.activeQuests ?? [];
          }
          return [];
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        updates.push({ table, values });
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };
  const system = new DatabaseSystem({} as never);
  const internals = system as unknown as {
    db: object;
    isDestroying: boolean;
    executeInTransaction: <T>(
      callback: (transaction: typeof tx) => Promise<T>,
      transactionOptions: unknown,
    ) => Promise<T>;
  };
  internals.db = {};
  internals.isDestroying = false;
  internals.executeInTransaction = vi.fn(async (callback) => callback(tx));
  return { system, internals, tx, inserts, updates };
}

function storedOperation(req: GroundItemMobLootCommitRequest) {
  return {
    playerId: KILLER_ID,
    operationType: "ground_item_mob_loot",
    completed: true,
    operationState: {
      version: 2,
      requestFingerprint: req.requestFingerprint,
      mobId: req.mobId,
      mobType: req.mobType,
      deathTimestamp: req.deathTimestamp,
      position: req.position,
      killToken: req.killToken,
      attackStyle: req.attackStyle,
      damageDealt: req.damageDealt,
      combatProgress: [
        {
          skill: "strength",
          xpAmount: 80,
          awardedXp: 80,
          operationCommittedXp: 80,
        },
        {
          skill: "constitution",
          xpAmount: 26,
          awardedXp: 26,
          operationCommittedXp: 1_180,
        },
      ],
      dropped: [
        { itemId: "air_rune", quantity: 5 },
        { itemId: "mind_rune", quantity: 2 },
      ],
      sources: req.sources,
      sourceIds: req.sources.map((source) => source.preferredSourceId),
    },
  };
}

describe("DatabaseSystem mob-loot custody", () => {
  it("co-commits the first frozen loot roll, all sources, and operation receipt", async () => {
    const req = await request();
    const fixture = createFixture({
      activeQuests: [
        {
          questId: "goblin_slayer",
          currentStage: "kill_goblins",
          startedAt: NOW - 10_000,
        },
      ],
    });

    await expect(
      fixture.system.commitGroundItemMobLootOperationAsync(req),
    ).resolves.toMatchObject({
      operationId: req.operationId,
      replayed: false,
      dropped: [
        { itemId: "air_rune", quantity: 5 },
        { itemId: "mind_rune", quantity: 2 },
      ],
      sources: [{ replayed: false }, { replayed: false }],
      combatProgress: [
        {
          skill: "strength",
          xpAmount: 80,
          awardedXp: 80,
          operationCommittedXp: 80,
          currentXp: 80,
          currentLevel: 1,
        },
        {
          skill: "constitution",
          xpAmount: 26,
          awardedXp: 26,
          operationCommittedXp: 1_180,
          currentXp: 1_180,
          currentLevel: 10,
        },
      ],
    });
    expect(fixture.internals.executeInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
    expect(fixture.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: schema.groundItemSources }),
        expect.objectContaining({
          table: schema.groundItemSourceContributions,
        }),
        expect.objectContaining({
          table: schema.operationsLog,
          values: expect.objectContaining({
            id: req.operationId,
            playerId: KILLER_ID,
            operationType: "ground_item_mob_loot",
            completed: true,
            timestamp: NOW,
            completedAt: NOW,
          }),
        }),
        expect.objectContaining({
          table: schema.questKillProgressReceipts,
          values: [
            {
              operationId: req.operationId,
              playerId: KILLER_ID,
              questId: "goblin_slayer",
              questStartedAt: NOW - 10_000,
              capturedStage: "kill_goblins",
              mobId: req.mobId,
              mobType: req.mobType,
              quantity: 1,
              createdAt: NOW,
            },
          ],
        }),
      ]),
    );
    expect(fixture.updates).toContainEqual({
      table: schema.characters,
      values: {
        strengthXp: 80,
        strengthLevel: 1,
        constitutionXp: 1_180,
        constitutionLevel: 10,
      },
    });
  });

  it("co-commits the existing controlled-style distribution to all four skills", async () => {
    const req = await request([], {
      attackStyle: "controlled",
      damageDealt: 20,
    });
    const fixture = createFixture();

    await expect(
      fixture.system.commitGroundItemMobLootOperationAsync(req),
    ).resolves.toMatchObject({
      combatProgress: [
        { skill: "attack", awardedXp: 26, currentXp: 26 },
        { skill: "strength", awardedXp: 26, currentXp: 26 },
        { skill: "defense", awardedXp: 26, currentXp: 26 },
        { skill: "constitution", awardedXp: 26, currentXp: 1_180 },
      ],
    });
    expect(fixture.updates).toContainEqual({
      table: schema.characters,
      values: {
        attackXp: 26,
        attackLevel: 1,
        strengthXp: 26,
        strengthLevel: 1,
        defenseXp: 26,
        defenseLevel: 1,
        constitutionXp: 1_180,
        constitutionLevel: 10,
      },
    });
  });

  it("replays the original committed roll even when a duplicate rerolls differently", async () => {
    const original = await request();
    const duplicate = {
      ...original,
      sources: [sourceRequest("mind_rune", 99, 14)],
    };
    const fixture = createFixture({
      existingOperation: storedOperation(original),
      replaySources: original.sources,
    });

    await expect(
      fixture.system.commitGroundItemMobLootOperationAsync(duplicate),
    ).resolves.toMatchObject({
      replayed: true,
      dropped: [
        { itemId: "air_rune", quantity: 5 },
        { itemId: "mind_rune", quantity: 2 },
      ],
      sources: [
        { itemId: "air_rune", quantity: 5, replayed: true },
        { itemId: "mind_rune", quantity: 2, replayed: true },
      ],
    });
    expect(fixture.inserts).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  it("persists and replays a zero-loot death so it can never reroll later", async () => {
    const req = await request([]);
    const first = createFixture();

    await expect(
      first.system.commitGroundItemMobLootOperationAsync(req),
    ).resolves.toMatchObject({ replayed: false, dropped: [], sources: [] });
    expect(first.inserts).toContainEqual(
      expect.objectContaining({
        table: schema.operationsLog,
        values: expect.objectContaining({ timestamp: NOW, completedAt: NOW }),
      }),
    );

    const replay = createFixture({
      existingOperation: {
        ...storedOperation({ ...req, sources: [] }),
        operationState: {
          ...storedOperation({ ...req, sources: [] }).operationState,
          dropped: [],
          sources: [],
          sourceIds: [],
        },
      },
      replaySources: [],
    });
    await expect(
      replay.system.commitGroundItemMobLootOperationAsync({
        ...req,
        sources: [sourceRequest("air_rune", 1, 12)],
      }),
    ).resolves.toMatchObject({ replayed: true, dropped: [], sources: [] });
  });

  it("rejects operation collisions and preexisting source contributions", async () => {
    const req = await request();
    const collision = createFixture({
      existingOperation: {
        ...storedOperation(req),
        operationState: {
          ...storedOperation(req).operationState,
          mobId: "different-mob-life",
        },
      },
    });
    await expect(
      collision.system.commitGroundItemMobLootOperationAsync(req),
    ).rejects.toThrow("ground_item_mob_loot_operation_id_conflict");

    const preexisting = createFixture({ replaySources: req.sources });
    await expect(
      preexisting.system.commitGroundItemMobLootOperationAsync(req),
    ).rejects.toThrow("ground_item_mob_loot_source_preexisting");
  });

  it("rejects a forged kill token before opening a transaction", async () => {
    const req = await request();
    req.killToken = "f".repeat(64);
    const identity = { ...req };
    delete (identity as Partial<GroundItemMobLootCommitRequest>)
      .requestFingerprint;
    delete (identity as Partial<GroundItemMobLootCommitRequest>).sources;
    req.requestFingerprint = createHash("sha256")
      .update(
        serializeGroundItemMobLootCommitFingerprint(
          identity as Omit<
            GroundItemMobLootCommitRequest,
            "requestFingerprint" | "sources"
          >,
        ),
        "utf8",
      )
      .digest("hex");
    const fixture = createFixture();

    await expect(
      fixture.system.commitGroundItemMobLootOperationAsync(req),
    ).rejects.toThrow("ground_item_mob_loot_kill_authority_invalid");
    expect(fixture.internals.executeInTransaction).not.toHaveBeenCalled();
  });

  it("rejects combat authority changed after the lethal event was signed", async () => {
    const req = await request();
    req.attackStyle = "defensive";
    const identity = { ...req };
    delete (identity as Partial<GroundItemMobLootCommitRequest>)
      .requestFingerprint;
    delete (identity as Partial<GroundItemMobLootCommitRequest>).sources;
    req.requestFingerprint = createHash("sha256")
      .update(
        serializeGroundItemMobLootCommitFingerprint(
          identity as Omit<
            GroundItemMobLootCommitRequest,
            "requestFingerprint" | "sources"
          >,
        ),
        "utf8",
      )
      .digest("hex");
    const fixture = createFixture();

    await expect(
      fixture.system.commitGroundItemMobLootOperationAsync(req),
    ).rejects.toThrow("ground_item_mob_loot_kill_authority_invalid");
    expect(fixture.internals.executeInTransaction).not.toHaveBeenCalled();
  });
});
