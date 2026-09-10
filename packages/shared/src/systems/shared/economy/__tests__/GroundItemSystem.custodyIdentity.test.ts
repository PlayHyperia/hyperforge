import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types/core/core";
import { EventBus } from "../../infrastructure/EventBus";
import { GroundItemSystem } from "../GroundItemSystem";

const ITEM_ID = "custody_identity_test_item";
const SECOND_ITEM_ID = "custody_identity_test_unstackable_item";

function sourceReceipts(requests: Array<Record<string, unknown>>) {
  const now = Date.now();
  return requests.map((request) => ({
    sourceId: request.preferredSourceId,
    contributionId: request.contributionId,
    requestFingerprint: request.requestFingerprint,
    replayed: false,
    status: "active",
    itemId: request.itemId,
    quantity: request.quantity,
    stackable: request.stackable,
    position: request.position,
    tile: request.tile,
    droppedBy: request.droppedBy,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + Number(request.lifetimeMs),
    lootProtectionExpiresAt:
      Number(request.lootProtectionMs) > 0
        ? now + Number(request.lootProtectionMs)
        : null,
    version: 1,
  }));
}

function createFixture(
  options: {
    destroyFailures?: number;
    spawnFailures?: number;
    database?: Record<string, unknown>;
    lifecycleCalls?: string[];
  } = {},
) {
  const entities = new Map<string, Record<string, unknown>>();
  let remainingDestroyFailures = options.destroyFailures ?? 0;
  let remainingSpawnFailures = options.spawnFailures ?? 0;
  const entityManager = {
    spawnEntity: vi.fn(async (config: Record<string, unknown>) => {
      options.lifecycleCalls?.push("presentation");
      if (remainingSpawnFailures > 0) {
        remainingSpawnFailures--;
        return null;
      }
      const properties = new Map(
        Object.entries(config.properties as Record<string, unknown>),
      );
      const entity = {
        ...config,
        getProperty: (key: string) => properties.get(key),
        setProperty: (key: string, value: unknown) =>
          properties.set(key, value),
        markNetworkDirty: vi.fn(),
      };
      entities.set(String(config.id), entity);
      return entity;
    }),
    destroyEntity: vi.fn((entityId: string) => {
      if (remainingDestroyFailures > 0) {
        remainingDestroyFailures--;
        return false;
      }
      return entities.delete(entityId);
    }),
  };
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    currentTick: 0,
    entities,
    getSystem: (name: string) => {
      if (name === "entity-manager") return entityManager;
      if (name === "terrain") return { getHeightAt: () => 0 };
      if (name === "database") return options.database;
      return undefined;
    },
  };
  const system = new GroundItemSystem(world as never);
  return { system, entityManager, entities };
}

describe("GroundItemSystem custody identity", () => {
  beforeEach(() => {
    ITEMS.set(ITEM_ID, {
      id: ITEM_ID,
      name: "Custody identity test item",
      description: "test",
      type: "resource",
      stackable: true,
      tradeable: true,
    } as Item);
    ITEMS.set(SECOND_ITEM_ID, {
      id: SECOND_ITEM_ID,
      name: "Custody identity unstackable test item",
      description: "test",
      type: "resource",
      stackable: false,
      tradeable: true,
    } as Item);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    ITEMS.delete(ITEM_ID);
    ITEMS.delete(SECOND_ITEM_ID);
    vi.restoreAllMocks();
  });

  it("allocates collision-resistant source IDs across system instances", async () => {
    const firstFixture = createFixture();
    const secondFixture = createFixture();
    await firstFixture.system.init();
    await secondFixture.system.init();

    const first = await firstFixture.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );
    const second = await secondFixture.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(first).toMatch(
      /^ground_item_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);
  });

  it("labels database-less presentations diagnostic and rejects incomplete authority", async () => {
    const diagnostic = createFixture();
    await diagnostic.system.init();
    const source = await diagnostic.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );
    expect(
      (
        diagnostic.entityManager.spawnEntity.mock.calls[0]?.[0] as {
          properties?: Record<string, unknown>;
        }
      ).properties,
    ).toMatchObject({
      custodyPolicy: "diagnostic_only",
      custodySourceId: source,
    });

    const incomplete = createFixture({ database: {} });
    await incomplete.system.init();
    await expect(
      incomplete.system.spawnGroundItem(
        ITEM_ID,
        1,
        { x: 5_000, y: 0, z: 5_000 },
        { despawnTime: 120_000 },
      ),
    ).resolves.toBe("");
    expect(incomplete.entityManager.spawnEntity).not.toHaveBeenCalled();
  });

  it.each([
    ["zero quantity", 0, { x: 5_000, y: 0, z: 5_000 }, 120_000, undefined],
    [
      "fractional quantity",
      1.5,
      { x: 5_000, y: 0, z: 5_000 },
      120_000,
      undefined,
    ],
    [
      "quantity overflow",
      2_147_483_648,
      { x: 5_000, y: 0, z: 5_000 },
      120_000,
      undefined,
    ],
    [
      "non-finite position",
      1,
      { x: Number.NaN, y: 0, z: 5_000 },
      120_000,
      undefined,
    ],
    ["zero lifetime", 1, { x: 5_000, y: 0, z: 5_000 }, 0, undefined],
    ["negative protection", 1, { x: 5_000, y: 0, z: 5_000 }, 120_000, -1],
  ])(
    "rejects %s before custody or presentation",
    async (_label, quantity, position, despawnTime, lootProtection) => {
      const fixture = createFixture();
      await fixture.system.init();

      await expect(
        fixture.system.spawnGroundItem(ITEM_ID, quantity, position, {
          despawnTime,
          lootProtection,
        }),
      ).resolves.toBe("");
      expect(fixture.entityManager.spawnEntity).not.toHaveBeenCalled();
    },
  );

  it("rejects a diagnostic stack merge that would overflow persisted custody", async () => {
    const fixture = createFixture();
    await fixture.system.init();
    const position = { x: 5_000, y: 0, z: 5_000 };
    const source = await fixture.system.spawnGroundItem(
      ITEM_ID,
      2_147_483_647,
      position,
      { despawnTime: 120_000 },
    );

    await expect(
      fixture.system.spawnGroundItem(ITEM_ID, 1, position, {
        despawnTime: 120_000,
      }),
    ).resolves.toBe("");
    expect(fixture.system.getGroundItem(source)?.quantity).toBe(2_147_483_647);
    expect(fixture.entityManager.spawnEntity).toHaveBeenCalledOnce();
  });

  it("does not merge into or expire a source while custody transfer is locked", async () => {
    const fixture = createFixture();
    await fixture.system.init();
    const position = { x: 5_000, y: 0, z: 5_000 };
    const first = await fixture.system.spawnGroundItem(ITEM_ID, 1, position, {
      despawnTime: 600,
    });
    expect(fixture.system.tryAcquirePickupLock(first, "agent-a", 0)).toBe(true);

    const second = await fixture.system.spawnGroundItem(ITEM_ID, 2, position, {
      despawnTime: 600,
    });
    expect(second).not.toBe(first);
    expect(fixture.system.getGroundItem(first)?.quantity).toBe(1);
    expect(fixture.system.getGroundItem(second)?.quantity).toBe(2);

    fixture.system.processTick(1);
    expect(fixture.system.getGroundItem(first)).not.toBeNull();
    fixture.system.releasePickupLock(first, "agent-a");
    fixture.system.processTick(1);
    expect(fixture.system.getGroundItem(first)).toBeNull();
  });

  it("quarantines and retries a committed presentation cleanup failure", async () => {
    const fixture = createFixture({ destroyFailures: 1 });
    await fixture.system.init();
    const source = await fixture.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(fixture.system.removeGroundItem(source)).toBe(false);
    const quarantined = fixture.entities.get(source) as {
      getProperty: (key: string) => unknown;
    };
    expect(quarantined.getProperty("visibleInPile")).toBe(false);
    expect(quarantined.getProperty("interactable")).toBe(false);
    expect(
      (
        fixture.system as unknown as {
          pendingPresentationCleanup: Map<string, unknown>;
        }
      ).pendingPresentationCleanup.size,
    ).toBe(1);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      pendingCustodyReconciliations: 1,
      pendingPresentationCleanups: 1,
      maxPresentationCleanupAttempts: 1,
    });
    fixture.system.processTick(1);
    expect(fixture.entityManager.destroyEntity).toHaveBeenCalledTimes(2);
    expect(
      (
        fixture.system as unknown as {
          pendingPresentationCleanup: Map<string, unknown>;
        }
      ).pendingPresentationCleanup.size,
    ).toBe(0);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      pendingCustodyReconciliations: 0,
      pendingPresentationCleanups: 0,
      maxPresentationCleanupAttempts: 0,
    });
  });

  it("commits a durable source before exposing its presentation", async () => {
    const lifecycleCalls: string[] = [];
    const registerGroundItemSourceAsync = vi.fn(
      async (request: Record<string, unknown>) => {
        lifecycleCalls.push("registry");
        const now = Date.now();
        return {
          sourceId: request.preferredSourceId,
          contributionId: request.contributionId,
          requestFingerprint: request.requestFingerprint,
          replayed: false,
          status: "active",
          itemId: request.itemId,
          quantity: request.quantity,
          stackable: true,
          position: request.position,
          tile: request.tile,
          droppedBy: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + Number(request.lifetimeMs),
          lootProtectionExpiresAt: null,
          version: 1,
        };
      },
    );
    const fixture = createFixture({
      database: { registerGroundItemSourceAsync },
      lifecycleCalls,
    });
    await fixture.system.init();

    const source = await fixture.system.spawnGroundItem(
      ITEM_ID,
      2,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(source).toMatch(/^ground_item_/);
    expect(lifecycleCalls).toEqual(["registry", "presentation"]);
    expect(registerGroundItemSourceAsync).toHaveBeenCalledTimes(1);
    expect(fixture.entities.has(source)).toBe(true);
    expect(
      (
        fixture.entityManager.spawnEntity.mock.calls[0]?.[0] as {
          properties?: Record<string, unknown>;
        }
      ).properties,
    ).toMatchObject({
      custodyPolicy: "durable_ground",
      custodySourceId: source,
    });
  });

  it("retries one exact contribution after an ambiguous registry response", async () => {
    let committedRequest: Record<string, unknown> | null = null;
    const registerGroundItemSourceAsync = vi.fn(
      async (request: Record<string, unknown>) => {
        if (!committedRequest) {
          committedRequest = structuredClone(request);
          throw new Error("response_lost_after_commit");
        }
        const now = Date.now();
        return {
          sourceId: request.preferredSourceId,
          contributionId: request.contributionId,
          requestFingerprint: request.requestFingerprint,
          replayed: true,
          status: "active",
          itemId: request.itemId,
          quantity: request.quantity,
          stackable: true,
          position: request.position,
          tile: request.tile,
          droppedBy: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + Number(request.lifetimeMs),
          lootProtectionExpiresAt: null,
          version: 1,
        };
      },
    );
    const fixture = createFixture({
      database: { registerGroundItemSourceAsync },
    });
    await fixture.system.init();

    const source = await fixture.system.spawnGroundItem(
      ITEM_ID,
      3,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(source).toMatch(/^ground_item_/);
    expect(registerGroundItemSourceAsync).toHaveBeenCalledTimes(2);
    expect(registerGroundItemSourceAsync.mock.calls[0]?.[0]).toEqual(
      registerGroundItemSourceAsync.mock.calls[1]?.[0],
    );
    expect(registerGroundItemSourceAsync.mock.calls[1]?.[0]).toEqual(
      committedRequest,
    );
    expect(fixture.entityManager.spawnEntity).toHaveBeenCalledTimes(1);
  });

  it("commits one exact multi-item batch before exposing any presentation", async () => {
    const lifecycleCalls: string[] = [];
    let committedRequests: Array<Record<string, unknown>> | null = null;
    const registerGroundItemSourceAsync = vi.fn();
    const registerGroundItemSourcesAsync = vi.fn(
      async (requests: Array<Record<string, unknown>>) => {
        lifecycleCalls.push("registry-batch");
        if (!committedRequests) {
          committedRequests = structuredClone(requests);
          throw new Error("response_lost_after_batch_commit");
        }
        return sourceReceipts(requests).map((receipt) => ({
          ...receipt,
          replayed: true,
        }));
      },
    );
    const fixture = createFixture({
      database: {
        registerGroundItemSourceAsync,
        registerGroundItemSourcesAsync,
      },
      lifecycleCalls,
    });
    await fixture.system.init();

    const sourceIds = await fixture.system.spawnGroundItems(
      [
        {
          id: "stackable-instance",
          itemId: ITEM_ID,
          quantity: 2,
          slot: 0,
          metadata: null,
        },
        {
          id: "unstackable-instance",
          itemId: SECOND_ITEM_ID,
          quantity: 1,
          slot: 1,
          metadata: null,
        },
      ],
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(sourceIds).toHaveLength(2);
    expect(new Set(sourceIds)).toHaveLength(2);
    expect(registerGroundItemSourceAsync).not.toHaveBeenCalled();
    expect(registerGroundItemSourcesAsync).toHaveBeenCalledTimes(2);
    expect(registerGroundItemSourcesAsync.mock.calls[0]?.[0]).toEqual(
      registerGroundItemSourcesAsync.mock.calls[1]?.[0],
    );
    expect(registerGroundItemSourcesAsync.mock.calls[1]?.[0]).toEqual(
      committedRequests,
    );
    expect(lifecycleCalls).toEqual([
      "registry-batch",
      "registry-batch",
      "presentation",
      "presentation",
    ]);
    expect(fixture.entityManager.spawnEntity).toHaveBeenCalledTimes(2);
  });

  it("retains every committed batch source when one presentation initially fails", async () => {
    const registerGroundItemSourceAsync = vi.fn();
    const registerGroundItemSourcesAsync = vi.fn(
      async (requests: Array<Record<string, unknown>>) =>
        sourceReceipts(requests),
    );
    const fixture = createFixture({
      database: {
        registerGroundItemSourceAsync,
        registerGroundItemSourcesAsync,
      },
      spawnFailures: 1,
    });
    await fixture.system.init();

    const sourceIds = await fixture.system.spawnGroundItems(
      [
        {
          id: "stackable-instance",
          itemId: ITEM_ID,
          quantity: 2,
          slot: 0,
          metadata: null,
        },
        {
          id: "unstackable-instance",
          itemId: SECOND_ITEM_ID,
          quantity: 1,
          slot: 1,
          metadata: null,
        },
      ],
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(sourceIds).toHaveLength(2);
    expect(registerGroundItemSourcesAsync).toHaveBeenCalledTimes(1);
    expect(fixture.entities.has(sourceIds[0])).toBe(false);
    expect(fixture.entities.has(sourceIds[1])).toBe(true);
    expect(fixture.entityManager.destroyEntity).not.toHaveBeenCalled();
    expect(
      (
        fixture.system as unknown as {
          pendingPresentationHydration: Map<string, unknown>;
        }
      ).pendingPresentationHydration.size,
    ).toBe(1);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      pendingCustodyReconciliations: 1,
      pendingPresentationHydrations: 1,
      presentationHydrationsInFlight: 0,
      maxPresentationHydrationAttempts: 0,
    });

    fixture.system.processTick(1);
    await vi.waitFor(() => {
      expect(fixture.entities.has(sourceIds[0])).toBe(true);
      expect(fixture.entities.has(sourceIds[1])).toBe(true);
      expect(
        (
          fixture.system as unknown as {
            pendingPresentationHydration: Map<string, unknown>;
          }
        ).pendingPresentationHydration.size,
      ).toBe(0);
    });
    expect(registerGroundItemSourcesAsync).toHaveBeenCalledTimes(1);
    expect(fixture.entityManager.spawnEntity).toHaveBeenCalledTimes(3);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      pendingCustodyReconciliations: 0,
      pendingPresentationHydrations: 0,
    });
  });

  it("hydrates only database-returned active sources before runtime work", async () => {
    const now = Date.now();
    const sourceId = "ground_item_00000000-0000-4000-8000-000000000001";
    const listActiveGroundItemSourcesAsync = vi.fn(async () => [
      {
        sourceId,
        itemId: ITEM_ID,
        quantity: 4,
        stackable: true,
        position: { x: 5_000.5, y: 0.2, z: 5_000.5 },
        tile: { x: 5_000, z: 5_000 },
        droppedBy: null,
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
        expiresAt: now + 119_000,
        lootProtectionExpiresAt: null,
        version: 1,
        status: "active",
      },
    ]);
    const fixture = createFixture({
      database: { listActiveGroundItemSourcesAsync },
    });
    await fixture.system.init();

    await fixture.system.start();

    expect(listActiveGroundItemSourcesAsync).toHaveBeenCalledTimes(1);
    expect(fixture.entities.has(sourceId)).toBe(true);
    expect(fixture.system.getGroundItem(sourceId)).toMatchObject({
      entityId: sourceId,
      itemId: ITEM_ID,
      quantity: 4,
    });
  });

  it("retains and retries a durable source whose first presentation spawn fails", async () => {
    const now = Date.now();
    const registerGroundItemSourceAsync = vi.fn(
      async (request: Record<string, unknown>) => ({
        sourceId: request.preferredSourceId,
        contributionId: request.contributionId,
        requestFingerprint: request.requestFingerprint,
        replayed: false,
        status: "active",
        itemId: request.itemId,
        quantity: request.quantity,
        stackable: true,
        position: request.position,
        tile: request.tile,
        droppedBy: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + Number(request.lifetimeMs),
        lootProtectionExpiresAt: null,
        version: 1,
      }),
    );
    const fixture = createFixture({
      database: { registerGroundItemSourceAsync },
      spawnFailures: 1,
    });
    await fixture.system.init();

    const source = await fixture.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 120_000 },
    );

    expect(source).toMatch(/^ground_item_/);
    expect(fixture.entities.has(source)).toBe(false);
    expect(
      (
        fixture.system as unknown as {
          pendingPresentationHydration: Map<string, unknown>;
        }
      ).pendingPresentationHydration.size,
    ).toBe(1);
    fixture.system.processTick(1);
    await vi.waitFor(() => {
      expect(fixture.entities.has(source)).toBe(true);
      expect(
        (
          fixture.system as unknown as {
            pendingPresentationHydration: Map<string, unknown>;
          }
        ).pendingPresentationHydration.size,
      ).toBe(0);
    });
    expect(fixture.entityManager.spawnEntity).toHaveBeenCalledTimes(2);
  });

  it("reports failed durable expiry custody without exposing source identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listActiveGroundItemSourcesAsync = vi.fn(async () => []);
    const registerGroundItemSourceAsync = vi.fn(
      async (request: Record<string, unknown>) => sourceReceipts([request])[0],
    );
    const expireGroundItemSourceAsync = vi.fn(async () => {
      throw new Error("database temporarily unavailable for private-source-id");
    });
    const fixture = createFixture({
      database: {
        listActiveGroundItemSourcesAsync,
        registerGroundItemSourceAsync,
        expireGroundItemSourceAsync,
      },
    });
    await fixture.system.init();

    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      durableHydrationStatus: "not_started",
      hydrationAuthorityAvailable: true,
      expiryAuthorityAvailable: true,
    });
    await fixture.system.start();
    const source = await fixture.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 600 },
    );

    fixture.system.processTick(1);
    await vi.waitFor(() => {
      expect(expireGroundItemSourceAsync).toHaveBeenCalledWith(source);
      expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
        durableHydrationStatus: "complete",
        trackedItems: 1,
        durableSources: 1,
        pendingCustodyReconciliations: 1,
        pendingDurableExpiries: 1,
        durableExpiriesInFlight: 0,
        maxDurableExpiryAttempts: 1,
      });
    });
    expect(
      JSON.stringify(fixture.system.getGroundItemCustodyStats()),
    ).not.toContain(source);
    expect(
      JSON.stringify(fixture.system.getGroundItemCustodyStats()),
    ).not.toContain("private-source-id");
  });

  it("retains expired durable custody with bounded retries when authority is absent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listActiveGroundItemSourcesAsync = vi.fn(async () => []);
    const registerGroundItemSourceAsync = vi.fn(
      async (request: Record<string, unknown>) => sourceReceipts([request])[0],
    );
    const fixture = createFixture({
      database: {
        listActiveGroundItemSourcesAsync,
        registerGroundItemSourceAsync,
      },
    });
    await fixture.system.init();
    await fixture.system.start();
    await fixture.system.spawnGroundItem(
      ITEM_ID,
      1,
      { x: 5_000, y: 0, z: 5_000 },
      { despawnTime: 600 },
    );

    fixture.system.processTick(1);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      durableHydrationStatus: "complete",
      expiryAuthorityAvailable: false,
      trackedItems: 1,
      durableSources: 1,
      pendingCustodyReconciliations: 1,
      pendingDurableExpiries: 1,
      durableExpiriesInFlight: 0,
      maxDurableExpiryAttempts: 1,
    });
    fixture.system.processTick(1);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      pendingDurableExpiries: 1,
      maxDurableExpiryAttempts: 1,
    });
    fixture.system.processTick(2);
    expect(fixture.system.getGroundItemCustodyStats()).toMatchObject({
      pendingDurableExpiries: 1,
      maxDurableExpiryAttempts: 2,
    });
  });
});
