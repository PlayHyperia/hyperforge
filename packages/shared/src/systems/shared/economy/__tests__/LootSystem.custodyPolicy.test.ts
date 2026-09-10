import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../../types/events";
import type { LootDrop } from "../LootTableService";
import { LootSystem } from "../LootSystem";
import { EventBus } from "../../infrastructure/EventBus";
import type {
  GroundItemMobLootCommitReceipt,
  GroundItemMobLootCommitRequest,
} from "../../../../types/network/database";

const MOB_DEATH = {
  mobId: "custody-mob-1",
  mobType: "custody-test-mob",
  level: 1,
  killedBy: "custody-agent-1",
  position: { x: 5_000, y: 0, z: 5_000 },
  timestamp: 1_788_087_600_000,
  lootOperationId: "ground-item-mob-loot:123e4567-e89b-42d3-a456-426614174000",
  killToken: "a".repeat(64),
  attackStyle: "aggressive",
  damageDealt: 20,
};

const COMBAT_PROGRESS = [
  {
    skill: "strength" as const,
    xpAmount: 80,
    awardedXp: 80,
    operationCommittedXp: 80,
    currentXp: 80,
    currentLevel: 1,
  },
  {
    skill: "constitution" as const,
    xpAmount: 26,
    awardedXp: 26,
    operationCommittedXp: 1_180,
    currentXp: 1_180,
    currentLevel: 10,
  },
];

function createFixture(sourceIds: string[], loot: LootDrop[]) {
  const spawnGroundItems = vi.fn(async () => sourceIds);
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    getSystem: (name: string) => {
      if (name === "ground-items") return { spawnGroundItems };
      if (name === "terrain") return { getHeightAt: () => 0 };
      return undefined;
    },
  };
  const system = new LootSystem(world as never);
  const emitTypedEvent = vi.spyOn(
    system as unknown as {
      emitTypedEvent: (type: EventType, payload: unknown) => void;
    },
    "emitTypedEvent",
  );
  Object.assign(system as unknown as Record<string, unknown>, {
    groundItemSystem: { spawnGroundItems },
    lootTableService: {
      rollLoot: () => loot,
      hasLootTable: () => true,
      getLootTableCount: () => 1,
    },
  });
  const handleMobDeath = (
    system as unknown as {
      handleMobDeath: (data: typeof MOB_DEATH) => Promise<void>;
    }
  ).handleMobDeath.bind(system);
  return { handleMobDeath, spawnGroundItems, emitTypedEvent };
}

function createAtomicFixture(
  loot: LootDrop[],
  options: {
    receiptItems?: LootDrop[];
    replayed?: boolean;
    expose?: () => Promise<boolean>;
    databaseAvailable?: boolean;
    commit?: (
      request: GroundItemMobLootCommitRequest,
      receipt: GroundItemMobLootCommitReceipt,
    ) => Promise<GroundItemMobLootCommitReceipt>;
  } = {},
) {
  const sourcePlan = loot.map((item, index) => ({
    contributionId: `ground-item-source:123e4567-e89b-42d3-a456-42661417400${index}`,
    preferredSourceId: `ground_item_123e4567-e89b-42d3-a456-42661417400${index}`,
    itemId: item.itemId,
    quantity: item.quantity,
    stackable: true,
    position: { x: 5_000.5, y: 0.2, z: 5_000.5 },
    tile: { x: 5_000, z: 5_000 },
    droppedBy: MOB_DEATH.killedBy,
    lifetimeMs: 120_000,
    lootProtectionMs: 60_000,
    allowMerge: false,
    requestFingerprint: `${index}`.repeat(64).slice(0, 64),
  }));
  const receiptItems = options.receiptItems ?? loot;
  const receiptSources = receiptItems.map((item, index) => ({
    sourceId: `ground_item_223e4567-e89b-42d3-a456-42661417400${index}`,
    status: "active" as const,
    itemId: item.itemId,
    quantity: item.quantity,
    stackable: true,
    position: { x: 5_000.5, y: 0.2, z: 5_000.5 },
    tile: { x: 5_000, z: 5_000 },
    droppedBy: MOB_DEATH.killedBy,
    createdAt: MOB_DEATH.timestamp,
    updatedAt: MOB_DEATH.timestamp,
    expiresAt: MOB_DEATH.timestamp + 120_000,
    lootProtectionExpiresAt: MOB_DEATH.timestamp + 60_000,
    version: 1,
    contributionId: `ground-item-source:223e4567-e89b-42d3-a456-42661417400${index}`,
    requestFingerprint: "b".repeat(64),
    replayed: options.replayed ?? false,
  }));
  const prepareDurableSourceBatchRegistration = vi.fn(async () => sourcePlan);
  const exposeCommittedDurableSource = vi.fn(
    options.expose ?? (async () => true),
  );
  const commitGroundItemMobLootOperationAsync = vi.fn(
    async (request: GroundItemMobLootCommitRequest) => {
      const receipt: GroundItemMobLootCommitReceipt = {
        operationId: request.operationId,
        killedBy: request.killedBy,
        requestFingerprint: request.requestFingerprint,
        replayed: options.replayed ?? false,
        mobId: request.mobId,
        mobType: request.mobType,
        deathTimestamp: request.deathTimestamp,
        position: request.position,
        killToken: request.killToken,
        attackStyle: request.attackStyle,
        damageDealt: request.damageDealt,
        combatProgress: COMBAT_PROGRESS,
        dropped: receiptItems,
        sources: receiptSources,
      };
      return options.commit ? options.commit(request, receipt) : receipt;
    },
  );
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    getSystem: (name: string) => {
      if (name === "ground-items") {
        return {
          prepareDurableSourceBatchRegistration,
          exposeCommittedDurableSource,
        };
      }
      if (name === "database") {
        return options.databaseAvailable === false
          ? {}
          : { commitGroundItemMobLootOperationAsync };
      }
      if (name === "terrain") return { getHeightAt: () => 0 };
      return undefined;
    },
  };
  const system = new LootSystem(world as never);
  const emitTypedEvent = vi.spyOn(
    system as unknown as {
      emitTypedEvent: (type: EventType, payload: unknown) => void;
    },
    "emitTypedEvent",
  );
  Object.assign(system as unknown as Record<string, unknown>, {
    groundItemSystem: {
      prepareDurableSourceBatchRegistration,
      exposeCommittedDurableSource,
    },
    lootTableService: {
      rollLoot: () => loot,
      hasLootTable: () => true,
      getLootTableCount: () => 1,
    },
  });
  const handleMobDeath = (
    system as unknown as {
      handleMobDeath: (data: typeof MOB_DEATH) => Promise<void>;
    }
  ).handleMobDeath.bind(system);
  return {
    system,
    world,
    handleMobDeath,
    prepareDurableSourceBatchRegistration,
    exposeCommittedDurableSource,
    commitGroundItemMobLootOperationAsync,
    emitTypedEvent,
  };
}

describe("LootSystem durable custody policy", () => {
  it("publishes loot only after a complete all-or-nothing source batch", async () => {
    const fixture = createFixture(
      ["source-a", "source-b"],
      [
        { itemId: "bones", quantity: 1 },
        { itemId: "coins", quantity: 12 },
      ],
    );

    await expect(fixture.handleMobDeath(MOB_DEATH)).resolves.toBeUndefined();
    expect(fixture.spawnGroundItems).toHaveBeenCalledWith(
      [
        expect.objectContaining({ itemId: "bones", quantity: 1 }),
        expect.objectContaining({ itemId: "coins", quantity: 12 }),
      ],
      {
        x: MOB_DEATH.position.x,
        y: expect.any(Number),
        z: MOB_DEATH.position.z,
      },
      expect.objectContaining({
        droppedBy: MOB_DEATH.killedBy,
        scatter: false,
      }),
      true,
    );
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
      EventType.LOOT_DROPPED,
      expect.objectContaining({ mobId: MOB_DEATH.mobId }),
    );
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(EventType.COMBAT_KILL, {
      attackerId: MOB_DEATH.killedBy,
      targetId: MOB_DEATH.mobId,
      damageDealt: MOB_DEATH.damageDealt,
      attackStyle: MOB_DEATH.attackStyle,
    });
  });

  it("rejects an incomplete source batch without publishing loot success", async () => {
    const fixture = createFixture(
      ["source-a"],
      [
        { itemId: "bones", quantity: 1 },
        { itemId: "coins", quantity: 12 },
      ],
    );

    await expect(fixture.handleMobDeath(MOB_DEATH)).rejects.toThrow(
      "mob_loot_source_batch_incomplete",
    );
    expect(fixture.emitTypedEvent).not.toHaveBeenCalledWith(
      EventType.LOOT_DROPPED,
      expect.anything(),
    );
    expect(fixture.emitTypedEvent).not.toHaveBeenCalledWith(
      EventType.COMBAT_KILL,
      expect.anything(),
    );
  });
});

describe("LootSystem atomic mob-death operation", () => {
  it("publishes only database-committed loot after source presentation", async () => {
    const fixture = createAtomicFixture([
      { itemId: "bones", quantity: 1 },
      { itemId: "coins", quantity: 12 },
    ]);

    await expect(fixture.handleMobDeath(MOB_DEATH)).resolves.toBeUndefined();
    expect(fixture.commitGroundItemMobLootOperationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: MOB_DEATH.lootOperationId,
        killedBy: MOB_DEATH.killedBy,
        mobId: MOB_DEATH.mobId,
        mobType: MOB_DEATH.mobType,
        deathTimestamp: MOB_DEATH.timestamp,
        killToken: MOB_DEATH.killToken,
        attackStyle: MOB_DEATH.attackStyle,
        damageDealt: MOB_DEATH.damageDealt,
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        sources: expect.any(Array),
      }),
    );
    expect(fixture.exposeCommittedDurableSource).toHaveBeenCalledTimes(2);
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
      EventType.MOB_LOOT_COMMITTED,
      {
        playerId: MOB_DEATH.killedBy,
        lootOperationId: MOB_DEATH.lootOperationId,
        replayed: false,
        combatProgress: COMBAT_PROGRESS,
      },
    );
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
      EventType.LOOT_DROPPED,
      expect.objectContaining({
        lootOperationId: MOB_DEATH.lootOperationId,
        replayed: false,
      }),
    );
    expect(fixture.emitTypedEvent).not.toHaveBeenCalledWith(
      EventType.COMBAT_KILL,
      expect.anything(),
    );
  });

  it("publishes the stored first roll rather than a duplicate event's reroll", async () => {
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }], {
      receiptItems: [{ itemId: "mind_rune", quantity: 2 }],
      replayed: true,
    });

    await fixture.handleMobDeath(MOB_DEATH);
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
      EventType.LOOT_DROPPED,
      expect.objectContaining({
        items: [{ itemId: "mind_rune", quantity: 2 }],
        replayed: true,
      }),
    );
  });

  it("commits a zero-loot operation without inventing a success event", async () => {
    const fixture = createAtomicFixture([]);

    await fixture.handleMobDeath(MOB_DEATH);
    expect(fixture.prepareDurableSourceBatchRegistration).toHaveBeenCalledWith(
      [],
      expect.any(Object),
      expect.any(Object),
    );
    expect(fixture.commitGroundItemMobLootOperationAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
      EventType.MOB_LOOT_COMMITTED,
      {
        playerId: MOB_DEATH.killedBy,
        lootOperationId: MOB_DEATH.lootOperationId,
        replayed: false,
        combatProgress: COMBAT_PROGRESS,
      },
    );
    expect(fixture.emitTypedEvent).not.toHaveBeenCalledWith(
      EventType.LOOT_DROPPED,
      expect.anything(),
    );
  });

  it("never downgrades committed custody when presentation throws", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }], {
      expose: async () => {
        throw new Error("renderer unavailable");
      },
    });

    try {
      await expect(fixture.handleMobDeath(MOB_DEATH)).resolves.toBeUndefined();
    } finally {
      error.mockRestore();
    }
    expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
      EventType.LOOT_DROPPED,
      expect.objectContaining({ mobId: MOB_DEATH.mobId }),
    );
  });

  it("fails closed when a database system lacks mob-loot authority", async () => {
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }], {
      databaseAvailable: false,
    });

    await expect(fixture.handleMobDeath(MOB_DEATH)).rejects.toThrow(
      "ground_item_mob_loot_database_authority_incomplete",
    );
    expect(
      fixture.prepareDurableSourceBatchRegistration,
    ).not.toHaveBeenCalled();
    expect(fixture.emitTypedEvent).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated death event before rolling or committing", async () => {
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }]);
    const rollLoot = vi.fn(() => [{ itemId: "bones", quantity: 1 }]);
    Object.assign(fixture.system as unknown as Record<string, unknown>, {
      lootTableService: {
        rollLoot,
        hasLootTable: () => true,
        getLootTableCount: () => 1,
      },
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await fixture.system.init();
      fixture.world.$eventBus.emitEvent(EventType.NPC_DIED, {
        ...MOB_DEATH,
        timestamp: Date.now(),
        killToken: "f".repeat(64),
      });
      await fixture.world.$eventBus.waitForPendingHandlers();
    } finally {
      consoleError.mockRestore();
      fixture.system.destroy();
    }
    expect(rollLoot).not.toHaveBeenCalled();
    expect(
      fixture.commitGroundItemMobLootOperationAsync,
    ).not.toHaveBeenCalled();
  });

  it("keeps readiness failed until an invalid commit response reconciles exactly", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let responses = 0;
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }], {
      commit: async (_request, receipt) => {
        responses++;
        return responses === 1
          ? { ...receipt, combatProgress: [] }
          : { ...receipt, replayed: true };
      },
    });
    try {
      await fixture.handleMobDeath(MOB_DEATH);
      expect(fixture.system.getLootCustodyStats()).toMatchObject({
        pendingMobLootCommits: 1,
        mobLootCommitsBlocked: 0,
      });
      expect(fixture.emitTypedEvent).not.toHaveBeenCalledWith(
        EventType.MOB_LOOT_COMMITTED,
        expect.anything(),
      );

      await (
        fixture.system as unknown as {
          drainMobLootReconciliations: (now: number) => Promise<void>;
        }
      ).drainMobLootReconciliations(Date.now() + 5_000);

      expect(responses).toBe(2);
      expect(fixture.system.getLootCustodyStats()).toMatchObject({
        pendingMobLootCommits: 0,
        mobLootCommitsBlocked: 0,
      });
      expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
        EventType.MOB_LOOT_COMMITTED,
        expect.objectContaining({
          lootOperationId: MOB_DEATH.lootOperationId,
          replayed: true,
          combatProgress: COMBAT_PROGRESS,
        }),
      );
    } finally {
      fixture.system.destroy();
      errors.mockRestore();
    }
  });

  it("keeps reconciling the exact request after the foreground response-loss budget", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const requests: GroundItemMobLootCommitRequest[] = [];
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }], {
      commit: async (request, receipt) => {
        requests.push(request);
        return { ...receipt, replayed: true };
      },
    });
    const foreground = vi
      .spyOn(
        fixture.system as unknown as {
          commitMobLootWithExactRetry: () => Promise<never>;
        },
        "commitMobLootWithExactRetry",
      )
      .mockRejectedValueOnce(
        new Error(`mob_loot_commit_unknown:${MOB_DEATH.lootOperationId}`),
      );

    try {
      await fixture.handleMobDeath(MOB_DEATH);
      expect(fixture.system.getLootCustodyStats()).toEqual({
        pendingMobLootCommits: 1,
        mobLootCommitsInFlight: 0,
        mobLootCommitsBlocked: 0,
        maxMobLootCommitAttempts: 8,
      });

      await (
        fixture.system as unknown as {
          drainMobLootReconciliations: (now: number) => Promise<void>;
        }
      ).drainMobLootReconciliations(Date.now() + 5_000);

      expect(foreground).toHaveBeenCalledOnce();
      expect(
        fixture.commitGroundItemMobLootOperationAsync,
      ).toHaveBeenCalledOnce();
      expect(new Set(requests).size).toBe(1);
      expect(fixture.system.getLootCustodyStats()).toEqual({
        pendingMobLootCommits: 0,
        mobLootCommitsInFlight: 0,
        mobLootCommitsBlocked: 0,
        maxMobLootCommitAttempts: 0,
      });
      expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
        EventType.MOB_LOOT_COMMITTED,
        {
          playerId: MOB_DEATH.killedBy,
          lootOperationId: MOB_DEATH.lootOperationId,
          replayed: true,
          combatProgress: COMBAT_PROGRESS,
        },
      );
      expect(fixture.emitTypedEvent).toHaveBeenCalledWith(
        EventType.LOOT_DROPPED,
        expect.objectContaining({
          lootOperationId: MOB_DEATH.lootOperationId,
          replayed: true,
        }),
      );
    } finally {
      fixture.system.destroy();
      errors.mockRestore();
    }
  });

  it("fails readiness stats closed when exact reconciliation reaches a definitive conflict", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let attempts = 0;
    const fixture = createAtomicFixture([{ itemId: "bones", quantity: 1 }], {
      commit: async () => {
        attempts++;
        throw new Error("ground_item_mob_loot_operation_id_conflict");
      },
    });
    vi.spyOn(
      fixture.system as unknown as {
        commitMobLootWithExactRetry: () => Promise<never>;
      },
      "commitMobLootWithExactRetry",
    ).mockRejectedValueOnce(
      new Error(`mob_loot_commit_unknown:${MOB_DEATH.lootOperationId}`),
    );

    try {
      await fixture.handleMobDeath(MOB_DEATH);
      await (
        fixture.system as unknown as {
          drainMobLootReconciliations: (now: number) => Promise<void>;
        }
      ).drainMobLootReconciliations(Date.now() + 5_000);

      expect(attempts).toBe(1);
      expect(fixture.system.getLootCustodyStats()).toEqual({
        pendingMobLootCommits: 1,
        mobLootCommitsInFlight: 0,
        mobLootCommitsBlocked: 1,
        maxMobLootCommitAttempts: 9,
      });
      expect(fixture.emitTypedEvent).not.toHaveBeenCalledWith(
        EventType.MOB_LOOT_COMMITTED,
        expect.anything(),
      );
    } finally {
      fixture.system.destroy();
      errors.mockRestore();
    }
  });
});
