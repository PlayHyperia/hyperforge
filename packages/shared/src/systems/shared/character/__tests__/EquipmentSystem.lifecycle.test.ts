import { afterEach, describe, expect, it, vi } from "vitest";

import { dataManager } from "../../../../data/DataManager";
import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { EquipmentSystem } from "../EquipmentSystem";

describe("EquipmentSystem player lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose the PLAYER_REGISTERED placeholder as hydrated equipment", async () => {
    let releaseEquipmentLoad:
      | ((
          rows: Array<{ slotType: string; itemId: string; quantity: number }>,
        ) => void)
      | undefined;
    const equipmentLoad = new Promise<
      Array<{ slotType: string; itemId: string; quantity: number }>
    >((resolve) => {
      releaseEquipmentLoad = resolve;
    });
    const eventBus = new EventBus();
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => undefined),
      getPlayerEquipmentAsync: vi.fn(async () => equipmentLoad),
    };
    const world = {
      $eventBus: eventBus,
      isServer: true,
      network: { send: vi.fn() },
      getSystem: (name: string) => (name === "database" ? database : undefined),
    };
    vi.spyOn(dataManager, "getItem").mockImplementation((itemId: string) =>
      itemId === "bronze_sword"
        ? ({
            id: itemId,
            name: "Bronze Sword",
            type: "weapon",
            equipSlot: "weapon",
          } as never)
        : null,
    );

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();

    // Embedded agents emit JOINED first, then REGISTERED while JOINED's
    // database fallback is still pending.
    eventBus.emitEvent(
      EventType.PLAYER_JOINED,
      { playerId: "agent-a" },
      "test",
    );
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );

    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBeNull();
    expect(equipment.isEquipmentReady("agent-a")).toBe(false);

    releaseEquipmentLoad?.([
      { slotType: "weapon", itemId: "bronze_sword", quantity: 1 },
    ]);
    await vi.waitFor(() => {
      expect(equipment.isEquipmentReady("agent-a")).toBe(true);
    });
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_sword",
    );
  });

  it("persists the exact direct-equipped ammunition quantity before returning", async () => {
    const eventBus = new EventBus();
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => undefined),
      getPlayerEquipmentAsync: vi.fn(async () => []),
    };
    const player = { id: "agent-a", data: {} };
    const world = {
      $eventBus: eventBus,
      isServer: true,
      entities: new Map([[player.id, player]]),
      network: { send: vi.fn() },
      getPlayer: (playerId: string) =>
        playerId === player.id ? player : undefined,
      getSystem: (name: string) => (name === "database" ? database : undefined),
    };
    vi.spyOn(dataManager, "getItem").mockImplementation((itemId: string) =>
      itemId === "rune_arrow"
        ? ({
            id: itemId,
            name: "Rune Arrow",
            type: "ammunition",
            equipSlot: "arrows",
            stackable: true,
          } as never)
        : null,
    );

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: player.id },
      "test",
    );

    await expect(
      equipment.equipItemDirect(player.id, "rune_arrow", 500),
    ).resolves.toMatchObject({ success: true, equippedSlot: "arrows" });
    expect(equipment.getArrowCount(player.id)).toBe(500);
    expect(database.savePlayerEquipmentAsync).toHaveBeenLastCalledWith(
      player.id,
      [{ slotType: "arrows", itemId: "rune_arrow", quantity: 500 }],
    );
  });

  it("strict reload replaces stale live slots when persisted equipment is empty", async () => {
    const eventBus = new EventBus();
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => undefined),
      getPlayerEquipmentAsync: vi
        .fn()
        .mockResolvedValueOnce([
          { slotType: "weapon", itemId: "bronze_sword", quantity: 1 },
        ])
        .mockResolvedValueOnce([]),
    };
    const world = {
      $eventBus: eventBus,
      isServer: true,
      network: { send: vi.fn() },
      getSystem: (name: string) => (name === "database" ? database : undefined),
    };
    vi.spyOn(dataManager, "getItem").mockImplementation((itemId: string) =>
      itemId === "bronze_sword"
        ? ({
            id: itemId,
            name: "Bronze Sword",
            type: "weapon",
            equipSlot: "weapon",
            bonuses: { meleeStrength: 3 },
          } as never)
        : null,
    );

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );

    await equipment.reloadFromDatabase("agent-a");
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_sword",
    );

    await equipment.reloadFromDatabase("agent-a");
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBeNull();
    expect(equipment.getEquipmentStats("agent-a")).toEqual(
      expect.objectContaining({ strength: 0, attack: 0, defense: 0 }),
    );
  });

  it("normalizes defence requirements and includes magic in live skill checks", async () => {
    const eventBus = new EventBus();
    const items = new Map([
      [
        "rune_body",
        {
          id: "rune_body",
          name: "Rune Body",
          type: "armor",
          equipSlot: "body",
          requirements: { skills: { defence: 40 } },
        },
      ],
      [
        "mystic_body",
        {
          id: "mystic_body",
          name: "Mystic Body",
          type: "armor",
          equipSlot: "body",
          requirements: { skills: { magic: 40, defence: 20 } },
        },
      ],
    ]);
    const world = {
      $eventBus: eventBus,
      isServer: false,
      getSystem: () => undefined,
    };
    vi.spyOn(dataManager, "getItem").mockImplementation(
      (itemId: string) => (items.get(itemId) as never) ?? null,
    );

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    eventBus.emitEvent(
      EventType.SKILLS_UPDATED,
      {
        playerId: "agent-a",
        skills: {
          defense: { level: 40, xp: 0 },
          magic: { level: 39, xp: 0 },
        },
      },
      "test",
    );

    expect(equipment.canPlayerEquipItem("agent-a", "rune_body")).toBe(true);
    expect(equipment.canPlayerEquipItem("agent-a", "mystic_body")).toBe(false);

    eventBus.emitEvent(
      EventType.SKILLS_UPDATED,
      {
        playerId: "agent-a",
        skills: {
          defense: { level: 40, xp: 0 },
          magic: { level: 40, xp: 0 },
        },
      },
      "test",
    );
    expect(equipment.canPlayerEquipItem("agent-a", "mystic_body")).toBe(true);
  });

  it("saves once before unregister cleanup and ignores the following leave", async () => {
    const eventBus = new EventBus();
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => saveGate),
      getPlayerEquipmentAsync: vi.fn(async () => []),
    };
    const world = {
      $eventBus: eventBus,
      isServer: true,
      getSystem: (name: string) => (name === "database" ? database : undefined),
    };
    const equipment = new EquipmentSystem(world as never);
    await equipment.init();

    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    eventBus.emitEvent(
      EventType.PLAYER_UNREGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    eventBus.emitEvent(EventType.PLAYER_LEFT, { playerId: "agent-a" }, "test");

    expect(database.savePlayerEquipmentAsync).toHaveBeenCalledTimes(1);
    expect(
      (
        equipment as unknown as {
          equipmentCleanupInFlight: Set<string>;
        }
      ).equipmentCleanupInFlight.has("agent-a"),
    ).toBe(true);

    releaseSave?.();
    await saveGate;
    await vi.waitFor(() => {
      expect(
        (
          equipment as unknown as {
            playerEquipment: Map<string, unknown>;
            equipmentCleanupInFlight: Set<string>;
          }
        ).playerEquipment.has("agent-a"),
      ).toBe(false);
    });
    expect(
      (
        equipment as unknown as {
          equipmentCleanupInFlight: Set<string>;
        }
      ).equipmentCleanupInFlight.has("agent-a"),
    ).toBe(false);
  });

  it("returns an authoritative receipt only after owned inventory removal completes", async () => {
    const eventBus = new EventBus();
    let releaseRemoval: ((removed: boolean) => void) | undefined;
    const removalGate = new Promise<boolean>((resolve) => {
      releaseRemoval = resolve;
    });
    const inventory = {
      hasItem: vi.fn(() => true),
      getInventory: vi.fn(() => ({
        playerId: "agent-a",
        coins: 0,
        items: [
          {
            slot: 3,
            itemId: "bronze_longsword",
            quantity: 1,
          },
        ],
      })),
      hasItemAtSlot: vi.fn(
        (_playerId: string, itemId: string, slot: number) =>
          itemId === "bronze_longsword" && slot === 3,
      ),
      hasSpace: vi.fn(() => true),
      lockForTransaction: vi.fn(() => true),
      unlockTransaction: vi.fn(),
      removeItemDirect: vi.fn(async () => removalGate),
      addItemDirect: vi.fn(async () => true),
    };
    const player = { id: "agent-a", data: {} };
    const world = {
      $eventBus: eventBus,
      isServer: false,
      getPlayer: (playerId: string) =>
        playerId === "agent-a" ? player : undefined,
      getSystem: (name: string) =>
        name === "inventory" ? inventory : undefined,
    };
    vi.spyOn(dataManager, "getItem").mockImplementation((itemId: string) =>
      itemId === "bronze_longsword"
        ? ({
            id: itemId,
            name: "Bronze Longsword",
            type: "weapon",
            attackType: "MELEE",
            weaponType: "LONGSWORD",
            stackable: false,
            bonuses: { meleeStrength: 7 },
          } as never)
        : null,
    );

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );

    let settled = false;
    const pendingReceipt = equipment
      .equipOwnedItem("agent-a", "bronze_longsword")
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    await Promise.resolve();

    expect(inventory.removeItemDirect).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBeNull();

    releaseRemoval?.(true);
    await expect(pendingReceipt).resolves.toEqual({
      ok: true,
      playerId: "agent-a",
      itemId: "bronze_longsword",
      slot: "weapon",
      changed: true,
    });
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(equipment.getEquipmentStats("agent-a").strength).toBe(7);

    await expect(
      equipment.unequipOwnedItem("agent-a", "weapon"),
    ).resolves.toEqual({
      ok: true,
      playerId: "agent-a",
      itemId: "bronze_longsword",
      slot: "weapon",
      changed: true,
    });
    expect(inventory.addItemDirect).toHaveBeenCalledWith(
      "agent-a",
      { itemId: "bronze_longsword", quantity: 1 },
      true,
    );
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBeNull();
    expect(equipment.getEquipmentStats("agent-a").strength).toBe(0);
    expect(inventory.unlockTransaction).toHaveBeenCalledTimes(2);
  });

  it("merges an entire owned ammunition stack into matching equipped ammunition", async () => {
    const eventBus = new EventBus();
    const carriedItems = [{ slot: 4, itemId: "bronze_arrow", quantity: 40 }];
    let allowRemoval = false;
    const inventory = {
      hasItem: vi.fn(
        (_playerId: string, itemId: string, quantity: number) =>
          carriedItems
            .filter((item) => item.itemId === itemId)
            .reduce((sum, item) => sum + item.quantity, 0) >= quantity,
      ),
      getInventory: vi.fn(() => ({
        playerId: "agent-a",
        coins: 0,
        items: carriedItems,
      })),
      hasItemAtSlot: vi.fn((_playerId: string, itemId: string, slot: number) =>
        carriedItems.some(
          (item) => item.itemId === itemId && item.slot === slot,
        ),
      ),
      lockForTransaction: vi.fn(() => true),
      unlockTransaction: vi.fn(),
      removeItemDirect: vi.fn(
        async (
          _playerId: string,
          request: { itemId: string; quantity: number; slot?: number },
        ) => {
          if (!allowRemoval) return false;
          const index = carriedItems.findIndex(
            (item) =>
              item.itemId === request.itemId && item.slot === request.slot,
          );
          if (index < 0 || carriedItems[index].quantity !== request.quantity) {
            return false;
          }
          carriedItems.splice(index, 1);
          return true;
        },
      ),
    };
    const player = { id: "agent-a", data: {} };
    const world = {
      $eventBus: eventBus,
      isServer: false,
      getPlayer: (playerId: string) =>
        playerId === "agent-a" ? player : undefined,
      getSystem: (name: string) =>
        name === "inventory" ? inventory : undefined,
    };
    const arrow = {
      id: "bronze_arrow",
      name: "Bronze Arrow",
      type: "ammunition",
      equipSlot: "arrows",
      stackable: true,
    };
    vi.spyOn(dataManager, "getItem").mockImplementation((itemId: string) =>
      itemId === arrow.id ? (arrow as never) : null,
    );

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    const arrows = equipment.getPlayerEquipment("agent-a")?.arrows;
    if (!arrows) throw new Error("arrows slot missing");
    arrows.itemId = arrow.id;
    arrows.item = arrow as never;
    arrows.quantity = 10;

    await expect(
      equipment.equipOwnedItem("agent-a", arrow.id),
    ).resolves.toEqual({
      ok: false,
      playerId: "agent-a",
      itemId: arrow.id,
      slot: "arrows",
      changed: false,
      reason: "equip_rejected",
    });
    expect(carriedItems).toEqual([
      { slot: 4, itemId: "bronze_arrow", quantity: 40 },
    ]);
    expect(equipment.getPlayerEquipment("agent-a")?.arrows.quantity).toBe(10);

    allowRemoval = true;
    await expect(
      equipment.equipOwnedItem("agent-a", arrow.id),
    ).resolves.toEqual({
      ok: true,
      playerId: "agent-a",
      itemId: arrow.id,
      slot: "arrows",
      changed: true,
    });
    expect(inventory.removeItemDirect).toHaveBeenLastCalledWith(
      "agent-a",
      { itemId: arrow.id, quantity: 40, slot: 4 },
      true,
    );
    expect(carriedItems).toEqual([]);
    expect(equipment.getPlayerEquipment("agent-a")?.arrows.quantity).toBe(50);
    expect(inventory.unlockTransaction).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an already-equipped item from an unowned request", async () => {
    const eventBus = new EventBus();
    const inventory = {
      hasItem: vi.fn(() => false),
    };
    const player = { id: "agent-a", data: {} };
    const world = {
      $eventBus: eventBus,
      isServer: false,
      getPlayer: (playerId: string) =>
        playerId === "agent-a" ? player : undefined,
      getSystem: (name: string) =>
        name === "inventory" ? inventory : undefined,
    };
    const sword = {
      id: "bronze_longsword",
      name: "Bronze Longsword",
      type: "weapon",
      attackType: "MELEE",
      weaponType: "LONGSWORD",
      stackable: false,
    };
    const bow = {
      id: "shortbow",
      name: "Shortbow",
      type: "weapon",
      attackType: "RANGED",
      weaponType: "BOW",
      stackable: false,
    };
    vi.spyOn(dataManager, "getItem").mockImplementation((itemId: string) => {
      if (itemId === sword.id) return sword as never;
      if (itemId === bow.id) return bow as never;
      return null;
    });

    const equipment = new EquipmentSystem(world as never);
    await equipment.init();
    eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    const weapon = equipment.getPlayerEquipment("agent-a")?.weapon;
    if (!weapon) throw new Error("weapon slot missing");
    weapon.itemId = sword.id;
    weapon.item = sword as never;

    await expect(
      equipment.equipOwnedItem("agent-a", sword.id),
    ).resolves.toEqual({
      ok: true,
      playerId: "agent-a",
      itemId: sword.id,
      slot: "weapon",
      changed: false,
    });
    await expect(equipment.equipOwnedItem("agent-a", bow.id)).resolves.toEqual({
      ok: false,
      playerId: "agent-a",
      itemId: bow.id,
      slot: "weapon",
      changed: false,
      reason: "item_not_owned",
    });
  });
});

describe("EquipmentSystem whole duel preparation plan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createPlanFixture(
    commitImplementation?: (request: any) => Promise<any>,
  ) {
    const eventBus = new EventBus();
    const items = new Map<string, any>([
      [
        "bronze_longsword",
        {
          id: "bronze_longsword",
          name: "Bronze Longsword",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "melee",
          stackable: false,
        },
      ],
      [
        "shortbow",
        {
          id: "shortbow",
          name: "Shortbow",
          type: "weapon",
          equipSlot: "2h",
          attackType: "ranged",
          weaponType: "BOW",
          stackable: false,
        },
      ],
      [
        "bronze_arrow",
        {
          id: "bronze_arrow",
          name: "Bronze Arrow",
          type: "ammunition",
          equipSlot: "arrows",
          stackable: true,
        },
      ],
      [
        "lobster",
        {
          id: "lobster",
          name: "Lobster",
          type: "food",
          stackable: false,
        },
      ],
      [
        "wooden_shield",
        {
          id: "wooden_shield",
          name: "Wooden Shield",
          type: "armor",
          equipSlot: "shield",
          stackable: false,
        },
      ],
    ]);
    vi.spyOn(dataManager, "getItem").mockImplementation(
      (itemId: string) => items.get(itemId) ?? null,
    );

    const rawInventory = { playerId: "agent-a", coins: 0, items: [] as any[] };
    let locked = false;
    const inventory = {
      getInventory: vi.fn(() => rawInventory),
      queueOperation: vi.fn(async (_playerId: string, operation: () => any) =>
        operation(),
      ),
      lockForTransaction: vi.fn(() => {
        if (locked) return false;
        locked = true;
        return true;
      }),
      unlockTransaction: vi.fn(() => {
        locked = false;
      }),
      applyCommittedCombatLoadoutInventory: vi.fn(
        (_playerId: string, rows: any[]) => {
          rawInventory.items = rows.map((row) => ({
            slot: row.slotIndex,
            itemId: row.itemId,
            quantity: row.quantity,
            item: items.get(row.itemId),
          }));
          return true;
        },
      ),
      reloadFromDatabase: vi.fn(async () => {
        throw new Error("strict_inventory_reload_not_configured");
      }),
    };
    const commit = vi.fn(
      commitImplementation ??
        (async (request: any) => ({
          operationId: request.operationId,
          preparationId: request.preparationId,
          playerId: request.playerId,
          requestFingerprint: request.requestFingerprint,
          replayed: false,
          committed: request.committed,
          recoveryEvidence: request.recoveryEvidence,
        })),
    );
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => undefined),
      getPlayerEquipmentAsync: vi.fn(async () => []),
      commitDuelPreparationPlanOperationAsync: commit,
      getDuelPreparationPlanOperationAsync: vi.fn(async () => null),
    };
    const player = { id: "agent-a", data: { selectedSpell: null } };
    const world = {
      $eventBus: eventBus,
      isServer: true,
      entities: new Map([["agent-a", player]]),
      getPlayer: (playerId: string) =>
        playerId === "agent-a" ? player : undefined,
      getSystem: (name: string) =>
        name === "database"
          ? database
          : name === "inventory"
            ? inventory
            : undefined,
    };
    return {
      eventBus,
      world,
      items,
      inventory,
      rawInventory,
      commit,
      database,
      player,
    };
  }

  async function initializePlanEquipment(
    fixture: ReturnType<typeof createPlanFixture>,
  ) {
    const equipment = new EquipmentSystem(fixture.world as never);
    await equipment.init();
    fixture.eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    const weapon = equipment.getPlayerEquipment("agent-a")?.weapon;
    if (!weapon) throw new Error("weapon slot missing");
    weapon.itemId = "bronze_longsword";
    weapon.item = fixture.items.get("bronze_longsword");
    weapon.quantity = 1;
    return equipment;
  }

  const exactPlan = {
    operationId: "atomic-plan-operation",
    preparationId: "atomic-preparation",
    expectedBank: [
      { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
      { itemId: "bronze_arrow", quantity: 50, slot: 1, tabIndex: 0 },
      { itemId: "lobster", quantity: 2, slot: 2, tabIndex: 0 },
    ],
    committed: {
      bank: [{ itemId: "bronze_longsword", quantity: 1, slot: 0, tabIndex: 0 }],
      inventory: [
        { itemId: "lobster", quantity: 1, slotIndex: 0, metadata: null },
        { itemId: "lobster", quantity: 1, slotIndex: 1, metadata: null },
      ],
      equipment: [
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ],
      selectedSpell: null,
    },
    recoveryEvidence: {
      planningSource: "deterministic",
      planningPolicyVersion: "test-v1",
    },
  };

  it("refreshes inventory and equipment from persistence under the per-player transaction queue", async () => {
    const fixture = createPlanFixture();
    const equipment = await initializePlanEquipment(fixture);
    fixture.rawInventory.items = [
      {
        slot: 0,
        itemId: "bronze_longsword",
        quantity: 1,
        item: fixture.items.get("bronze_longsword"),
      },
    ];
    fixture.inventory.reloadFromDatabase.mockImplementation(async () => {
      fixture.rawInventory.items = [
        {
          slot: 0,
          itemId: "lobster",
          quantity: 1,
          item: fixture.items.get("lobster"),
        },
      ];
    });
    fixture.database.getPlayerEquipmentAsync.mockResolvedValue([
      { slotType: "weapon", itemId: "shortbow", quantity: 1 },
    ]);

    await expect(
      equipment.refreshOwnedDuelPreparationCustodyFromPersistence("agent-a"),
    ).resolves.toBe(true);

    expect(fixture.inventory.queueOperation).toHaveBeenCalledOnce();
    expect(fixture.inventory.lockForTransaction).toHaveBeenCalledOnce();
    expect(fixture.inventory.reloadFromDatabase).toHaveBeenCalledWith(
      "agent-a",
    );
    expect(fixture.database.getPlayerEquipmentAsync).toHaveBeenCalledWith(
      "agent-a",
    );
    expect(fixture.inventory.unlockTransaction).toHaveBeenCalledOnce();
    expect(fixture.rawInventory.items).toEqual([
      expect.objectContaining({ itemId: "lobster", quantity: 1 }),
    ]);
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
  });

  it("applies no live custody until one complete durable commit succeeds", async () => {
    let releaseCommit: ((receipt: any) => void) | undefined;
    const gate = new Promise<any>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createPlanFixture(async (request) =>
      gate.then(() => ({
        operationId: request.operationId,
        preparationId: request.preparationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
        replayed: false,
        committed: request.committed,
        recoveryEvidence: request.recoveryEvidence,
      })),
    );
    const equipment = await initializePlanEquipment(fixture);
    const pending = equipment.commitOwnedDuelPreparationPlan(
      "agent-a",
      exactPlan,
    );
    await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledOnce());

    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(fixture.rawInventory.items).toEqual([]);
    const requestFingerprint = fixture.commit.mock.calls[0][0]
      .requestFingerprint as string;
    expect(requestFingerprint).toMatch(/^[0-9a-f]{64}$/);

    releaseCommit?.({});
    await expect(pending).resolves.toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      requestFingerprint,
    });
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
    expect(equipment.getPlayerEquipment("agent-a")?.arrows.quantity).toBe(50);
    expect(fixture.rawInventory.items).toHaveLength(2);
  });

  it("orders an older equipment save before the authoritative whole-plan commit", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const fixture = createPlanFixture();
    fixture.database.savePlayerEquipmentAsync.mockImplementationOnce(
      async () => saveGate,
    );
    const equipment = await initializePlanEquipment(fixture);

    const staleSave = (
      equipment as unknown as {
        saveEquipmentToDatabase(playerId: string): Promise<void>;
      }
    ).saveEquipmentToDatabase("agent-a");
    await vi.waitFor(() =>
      expect(fixture.database.savePlayerEquipmentAsync).toHaveBeenCalledOnce(),
    );

    const planCommit = equipment.commitOwnedDuelPreparationPlan(
      "agent-a",
      exactPlan,
    );
    await Promise.resolve();
    expect(fixture.commit).not.toHaveBeenCalled();

    releaseSave();
    await staleSave;
    await expect(planCommit).resolves.toMatchObject({ ok: true });
    expect(
      fixture.database.savePlayerEquipmentAsync.mock.invocationCallOrder[0],
    ).toBeLessThan(fixture.commit.mock.invocationCallOrder[0]!);
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
  });

  it("replays the identical operation once after an ambiguous commit response", async () => {
    let calls = 0;
    const fixture = createPlanFixture(async (request) => {
      calls += 1;
      if (calls === 1) throw new Error("connection_lost_after_commit");
      return {
        operationId: request.operationId,
        preparationId: request.preparationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
        replayed: true,
        committed: request.committed,
        recoveryEvidence: request.recoveryEvidence,
      };
    });
    const equipment = await initializePlanEquipment(fixture);

    await expect(
      equipment.commitOwnedDuelPreparationPlan("agent-a", exactPlan),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    expect(fixture.commit).toHaveBeenCalledTimes(2);
    expect(fixture.commit.mock.calls[1][0]).toEqual(
      fixture.commit.mock.calls[0][0],
    );
  });

  it("strictly reconciles live custody when the post-commit projection apply fails", async () => {
    const fixture = createPlanFixture();
    const equipment = await initializePlanEquipment(fixture);
    fixture.inventory.applyCommittedCombatLoadoutInventory.mockReturnValue(
      false,
    );
    fixture.inventory.reloadFromDatabase.mockImplementation(async () => {
      fixture.rawInventory.items = exactPlan.committed.inventory.map((row) => ({
        slot: row.slotIndex,
        itemId: row.itemId,
        quantity: row.quantity,
        item: fixture.items.get(row.itemId),
      }));
    });
    fixture.database.getPlayerEquipmentAsync.mockResolvedValue(
      exactPlan.committed.equipment,
    );

    await expect(
      equipment.commitOwnedDuelPreparationPlan("agent-a", exactPlan),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(fixture.inventory.reloadFromDatabase).toHaveBeenCalledOnce();
    expect(fixture.database.getPlayerEquipmentAsync).toHaveBeenCalledWith(
      "agent-a",
    );
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
    expect(fixture.rawInventory.items).toHaveLength(2);
  });

  it("recovers the immutable whole-plan receipt without accepting planner input", async () => {
    const fixture = createPlanFixture();
    const equipment = await initializePlanEquipment(fixture);
    fixture.database.getDuelPreparationPlanOperationAsync.mockResolvedValue({
      operationId: exactPlan.operationId,
      preparationId: exactPlan.preparationId,
      playerId: "agent-a",
      requestFingerprint: "persisted-fingerprint",
      replayed: true,
      committed: exactPlan.committed,
      recoveryEvidence: exactPlan.recoveryEvidence,
    });

    await expect(
      equipment.recoverOwnedDuelPreparationPlan("agent-a", {
        operationId: exactPlan.operationId,
        preparationId: exactPlan.preparationId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      changed: false,
      recoveryEvidence: exactPlan.recoveryEvidence,
    });
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(
      fixture.database.getDuelPreparationPlanOperationAsync,
    ).toHaveBeenCalledWith({
      operationId: exactPlan.operationId,
      preparationId: exactPlan.preparationId,
      playerId: "agent-a",
    });
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
  });

  it("does not retry a deterministic stale-state rejection", async () => {
    const fixture = createPlanFixture(async () => {
      throw new Error("duel_preparation_plan_state_conflict");
    });
    const equipment = await initializePlanEquipment(fixture);

    await expect(
      equipment.commitOwnedDuelPreparationPlan("agent-a", exactPlan),
    ).resolves.toMatchObject({
      ok: false,
      reason: "persistence_failed",
      changed: false,
      replayed: false,
    });
    expect(fixture.commit).toHaveBeenCalledOnce();
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(fixture.rawInventory.items).toEqual([]);
  });

  it("treats cancellation winning an in-flight plan commit as capability revocation", async () => {
    const fixture = createPlanFixture(async () => {
      throw new Error("duel_preparation_plan_preparation_not_active");
    });
    const equipment = await initializePlanEquipment(fixture);

    await expect(
      equipment.commitOwnedDuelPreparationPlan("agent-a", exactPlan),
    ).resolves.toMatchObject({
      ok: false,
      reason: "preparation_capability_unavailable",
      changed: false,
      replayed: false,
    });
    expect(fixture.commit).toHaveBeenCalledOnce();
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(fixture.rawInventory.items).toEqual([]);
  });

  it("rejects a two-handed weapon and shield before persistence", async () => {
    const fixture = createPlanFixture();
    const equipment = await initializePlanEquipment(fixture);
    const invalid = {
      ...exactPlan,
      committed: {
        ...exactPlan.committed,
        bank: [],
        equipment: [
          ...exactPlan.committed.equipment,
          { slotType: "shield", itemId: "wooden_shield", quantity: 1 },
        ],
      },
      expectedBank: [
        ...exactPlan.expectedBank,
        { itemId: "wooden_shield", quantity: 1, slot: 3, tabIndex: 0 },
      ],
    };

    await expect(
      equipment.commitOwnedDuelPreparationPlan("agent-a", invalid),
    ).resolves.toMatchObject({ ok: false, reason: "plan_invalid" });
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});

describe("EquipmentSystem frozen combat loadout switching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createSwitchFixture(options?: {
    inventoryItems?: Array<{ slot: number; itemId: string; quantity: number }>;
    commit?: (request: any) => Promise<any>;
  }) {
    const eventBus = new EventBus();
    const itemDefinitions = new Map<string, any>([
      [
        "bronze_longsword",
        {
          id: "bronze_longsword",
          name: "Bronze Longsword",
          type: "weapon",
          attackType: "melee",
          weaponType: "LONGSWORD",
          equipSlot: "weapon",
          stackable: false,
        },
      ],
      [
        "shortbow",
        {
          id: "shortbow",
          name: "Shortbow",
          type: "weapon",
          attackType: "ranged",
          weaponType: "BOW",
          equipSlot: "2h",
          stackable: false,
        },
      ],
      [
        "bronze_arrow",
        {
          id: "bronze_arrow",
          name: "Bronze Arrow",
          type: "ammunition",
          equipSlot: "arrows",
          stackable: true,
        },
      ],
      [
        "wooden_shield",
        {
          id: "wooden_shield",
          name: "Wooden Shield",
          type: "armor",
          equipSlot: "shield",
          stackable: false,
        },
      ],
      [
        "bronze_platebody",
        {
          id: "bronze_platebody",
          name: "Bronze Platebody",
          type: "armor",
          equipSlot: "body",
          stackable: false,
        },
      ],
      [
        "leather_body",
        {
          id: "leather_body",
          name: "Leather Body",
          type: "armor",
          equipSlot: "body",
          stackable: false,
        },
      ],
      [
        "lobster",
        {
          id: "lobster",
          name: "Lobster",
          type: "food",
          stackable: false,
        },
      ],
    ]);
    for (let i = 0; i < 30; i++) {
      itemDefinitions.set(`filler_${i}`, {
        id: `filler_${i}`,
        name: `Filler ${i}`,
        type: "food",
        stackable: false,
      });
    }
    vi.spyOn(dataManager, "getItem").mockImplementation(
      (itemId: string) => itemDefinitions.get(itemId) ?? null,
    );

    const rawInventory = {
      playerId: "agent-a",
      coins: 0,
      items: (
        options?.inventoryItems ?? [
          { slot: 0, itemId: "shortbow", quantity: 1 },
          { slot: 1, itemId: "bronze_arrow", quantity: 50 },
          { slot: 2, itemId: "lobster", quantity: 4 },
        ]
      ).map((item) => ({
        ...item,
        item: itemDefinitions.get(item.itemId),
      })),
    };
    let locked = false;
    const inventory = {
      getInventory: vi.fn(() => rawInventory),
      queueOperation: vi.fn(
        async (_playerId: string, operation: () => Promise<boolean>) =>
          operation(),
      ),
      lockForTransaction: vi.fn(() => {
        if (locked) return false;
        locked = true;
        return true;
      }),
      unlockTransaction: vi.fn(() => {
        locked = false;
      }),
      applyCommittedCombatLoadoutInventory: vi.fn(
        (_playerId: string, rows: any[]) => {
          rawInventory.items = rows.map((row) => ({
            slot: row.slotIndex,
            itemId: row.itemId,
            quantity: row.quantity,
            item: itemDefinitions.get(row.itemId),
          }));
          return true;
        },
      ),
    };
    const commit = vi.fn(
      options?.commit ??
        (async (request: any) => ({
          operationId: request.operationId,
          playerId: request.playerId,
          requestFingerprint: request.requestFingerprint,
          replayed: false,
          committed: request.committed,
        })),
    );
    const database = {
      savePlayerEquipmentAsync: vi.fn(async () => undefined),
      getPlayerEquipmentAsync: vi.fn(async () => []),
      commitCombatLoadoutOperationAsync: commit,
    };
    const player = { id: "agent-a", data: { selectedSpell: null } };
    const entities = new Map([["agent-a", player]]);
    const world = {
      $eventBus: eventBus,
      isServer: true,
      entities,
      getPlayer: (playerId: string) =>
        playerId === "agent-a" ? player : undefined,
      getSystem: (name: string) => {
        if (name === "database") return database;
        if (name === "inventory") return inventory;
        return undefined;
      },
    };

    return {
      eventBus,
      world,
      database,
      inventory,
      rawInventory,
      commit,
      itemDefinitions,
      player,
    };
  }

  async function initializeSwitchEquipment(
    fixture: ReturnType<typeof createSwitchFixture>,
  ) {
    const equipment = new EquipmentSystem(fixture.world as never);
    await equipment.init();
    fixture.eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: "agent-a" },
      "test",
    );
    const weapon = equipment.getPlayerEquipment("agent-a")?.weapon;
    if (!weapon) throw new Error("weapon slot missing");
    weapon.itemId = "bronze_longsword";
    weapon.item = fixture.itemDefinitions.get("bronze_longsword");
    weapon.quantity = 1;
    return equipment;
  }

  const rangedRequest = {
    operationId: "cycle-1:agent-a:switch-1",
    requestFingerprint: "frozen-fingerprint:ranged",
    targetRole: "ranged" as const,
    allowedLoadouts: {
      ranged: {
        role: "ranged" as const,
        weaponId: "shortbow",
        arrowsId: "bronze_arrow",
        shieldId: null,
        spellId: null,
      },
    },
  };

  const shieldedMeleeRequest = {
    operationId: "cycle-1:agent-a:switch-melee-shield",
    requestFingerprint: "frozen-fingerprint:melee-shield",
    targetRole: "melee" as const,
    allowedLoadouts: {
      melee: {
        role: "melee" as const,
        weaponId: "bronze_longsword",
        arrowsId: null,
        shieldId: "wooden_shield",
        spellId: null,
      },
    },
  };

  it("changes no live custody until the atomic database commit succeeds", async () => {
    let releaseCommit: ((value: any) => void) | undefined;
    const commitGate = new Promise<any>((resolve) => {
      releaseCommit = resolve;
    });
    const fixture = createSwitchFixture({
      commit: async (request) => {
        const committed = await commitGate;
        return {
          operationId: request.operationId,
          playerId: request.playerId,
          requestFingerprint: request.requestFingerprint,
          replayed: false,
          committed,
        };
      },
    });
    const equipment = await initializeSwitchEquipment(fixture);

    let settled = false;
    const pending = equipment
      .switchOwnedCombatLoadout("agent-a", rangedRequest)
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    await vi.waitFor(() => expect(fixture.commit).toHaveBeenCalledOnce());
    const commitRequest = fixture.commit.mock.calls[0][0];

    expect(settled).toBe(false);
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(fixture.rawInventory.items.map((item) => item.itemId)).toEqual([
      "shortbow",
      "bronze_arrow",
      "lobster",
    ]);

    releaseCommit?.(commitRequest.committed);
    await expect(pending).resolves.toEqual({
      ok: true,
      playerId: "agent-a",
      operationId: rangedRequest.operationId,
      targetRole: "ranged",
      changed: true,
      replayed: false,
    });
    expect(commitRequest.expected).toEqual(
      expect.objectContaining({ selectedSpell: null }),
    );
    expect(commitRequest.committed.equipment).toEqual(
      expect.arrayContaining([
        {
          slotType: "weapon",
          itemId: "shortbow",
          quantity: 1,
        },
        {
          slotType: "arrows",
          itemId: "bronze_arrow",
          quantity: 50,
        },
      ]),
    );
    expect(commitRequest.committed.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "bronze_longsword", quantity: 1 }),
        expect.objectContaining({ itemId: "lobster", quantity: 4 }),
      ]),
    );
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
    expect(equipment.getPlayerEquipment("agent-a")?.arrows.quantity).toBe(50);
    expect(fixture.inventory.queueOperation).toHaveBeenCalledOnce();
    expect(fixture.inventory.unlockTransaction).toHaveBeenCalledOnce();
  });

  it("atomically equips an owned shield when switching to its frozen one-handed role", async () => {
    const fixture = createSwitchFixture({
      inventoryItems: [
        { slot: 0, itemId: "wooden_shield", quantity: 1 },
        { slot: 1, itemId: "lobster", quantity: 4 },
      ],
    });
    const equipment = await initializeSwitchEquipment(fixture);

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", shieldedMeleeRequest),
    ).resolves.toMatchObject({
      ok: true,
      targetRole: "melee",
      changed: true,
    });
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(equipment.getPlayerEquipment("agent-a")?.shield.itemId).toBe(
      "wooden_shield",
    );
    expect(fixture.rawInventory.items.map((item) => item.itemId)).toEqual([
      "lobster",
    ]);
    expect(fixture.commit.mock.calls[0][0].committed.equipment).toEqual(
      expect.arrayContaining([
        {
          slotType: "shield",
          itemId: "wooden_shield",
          quantity: 1,
        },
        {
          slotType: "weapon",
          itemId: "bronze_longsword",
          quantity: 1,
        },
      ]),
    );
  });

  it("binds an exact duel role observation to the atomic loadout request", async () => {
    const fixture = createSwitchFixture();
    const equipment = await initializeSwitchEquipment(fixture);
    const context = {
      operationId: "00000000-0000-4000-8000-000000000021",
      tick: 9,
      observedAt: 1_725_000_000_300,
      cycleId: "cycle-role",
      duelId: "duel-role",
      actorId: "agent-a",
      opponentId: "agent-b",
      phase: "FIGHTING" as const,
      combatRole: "melee" as const,
      tacticalMacro: "pressure" as const,
      targetRole: "ranged" as const,
    };
    const request = {
      ...rangedRequest,
      requestFingerprint: "a".repeat(64),
      publicActionObservation: context,
    };

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", request),
    ).resolves.toMatchObject({ ok: true, targetRole: "ranged" });
    expect(fixture.commit).toHaveBeenCalledWith(
      expect.objectContaining({ publicActionObservation: context }),
    );

    const invalidFixture = createSwitchFixture();
    const invalidEquipment = await initializeSwitchEquipment(invalidFixture);
    await expect(
      invalidEquipment.switchOwnedCombatLoadout("agent-a", {
        ...request,
        operationId: "cycle-role:invalid",
        publicActionObservation: { ...context, actorId: "wrong-agent" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "target_loadout_invalid",
    });
    expect(invalidFixture.commit).not.toHaveBeenCalled();
  });

  it("atomically replaces every frozen non-shield armor slot with conserved owned custody", async () => {
    const fixture = createSwitchFixture({
      inventoryItems: [
        { slot: 0, itemId: "shortbow", quantity: 1 },
        { slot: 1, itemId: "bronze_arrow", quantity: 50 },
        { slot: 2, itemId: "leather_body", quantity: 1 },
        { slot: 3, itemId: "lobster", quantity: 4 },
      ],
    });
    const equipment = await initializeSwitchEquipment(fixture);
    const liveEquipment = equipment.getPlayerEquipment("agent-a");
    if (!liveEquipment?.body) throw new Error("body slot missing");
    liveEquipment.body.itemId = "bronze_platebody";
    liveEquipment.body.item = fixture.itemDefinitions.get("bronze_platebody");
    liveEquipment.body.quantity = 1;

    const receipt = await equipment.switchOwnedCombatLoadout("agent-a", {
      ...rangedRequest,
      operationId: "cycle-1:agent-a:switch-ranged-armor",
      requestFingerprint: "frozen-fingerprint:ranged-armor",
      allowedLoadouts: {
        ranged: {
          ...rangedRequest.allowedLoadouts.ranged,
          armorIds: {
            helmet: null,
            body: "leather_body",
            legs: null,
            boots: null,
            gloves: null,
            cape: null,
            amulet: null,
            ring: null,
          },
        },
      },
    });
    if (!receipt.ok) throw new Error(receipt.reason);
    expect(receipt).toMatchObject({
      ok: true,
      targetRole: "ranged",
      changed: true,
    });
    expect(liveEquipment.body.itemId).toBe("leather_body");
    expect(fixture.rawInventory.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "bronze_platebody", quantity: 1 }),
        expect.objectContaining({ itemId: "lobster", quantity: 4 }),
      ]),
    );
    expect(fixture.rawInventory.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "leather_body" }),
      ]),
    );
    expect(fixture.commit.mock.calls[0][0].committed.equipment).toEqual(
      expect.arrayContaining([
        { slotType: "body", itemId: "leather_body", quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]),
    );
  });

  it.each([
    {
      name: "an incomplete armor map",
      armorIds: { body: "leather_body" },
    },
    {
      name: "an item assigned to the wrong armor slot",
      armorIds: {
        helmet: null,
        body: "wooden_shield",
        legs: null,
        boots: null,
        gloves: null,
        cape: null,
        amulet: null,
        ring: null,
      },
    },
  ])("rejects $name before persistence", async ({ armorIds }) => {
    const fixture = createSwitchFixture();
    const equipment = await initializeSwitchEquipment(fixture);

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", {
        ...rangedRequest,
        allowedLoadouts: {
          ranged: {
            ...rangedRequest.allowedLoadouts.ranged,
            armorIds,
          } as never,
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "target_loadout_invalid",
    });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("leaves all live state untouched when persistence fails", async () => {
    const fixture = createSwitchFixture({
      commit: async () => {
        throw new Error("database unavailable");
      },
    });
    const equipment = await initializeSwitchEquipment(fixture);

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", rangedRequest),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: "persistence_failed" }),
    );
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
    expect(fixture.rawInventory.items.map((item) => item.itemId)).toEqual([
      "shortbow",
      "bronze_arrow",
      "lobster",
    ]);
    expect(
      fixture.inventory.applyCommittedCombatLoadoutInventory,
    ).not.toHaveBeenCalled();
  });

  it("fails closed before persistence when a frozen target item is no longer owned", async () => {
    const fixture = createSwitchFixture({
      inventoryItems: [
        { slot: 0, itemId: "bronze_arrow", quantity: 50 },
        { slot: 1, itemId: "lobster", quantity: 4 },
      ],
    });
    const equipment = await initializeSwitchEquipment(fixture);

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", rangedRequest),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: "target_item_not_owned" }),
    );
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "bronze_longsword",
    );
  });

  it("rejects a two-handed switch that would overflow the frozen inventory", async () => {
    const inventoryItems = [
      { slot: 0, itemId: "shortbow", quantity: 1 },
      ...Array.from({ length: 27 }, (_, index) => ({
        slot: index + 1,
        itemId: `filler_${index}`,
        quantity: 1,
      })),
    ];
    const fixture = createSwitchFixture({ inventoryItems });
    const equipment = await initializeSwitchEquipment(fixture);
    const liveEquipment = equipment.getPlayerEquipment("agent-a");
    if (!liveEquipment?.shield || !liveEquipment.arrows) {
      throw new Error("equipment slots missing");
    }
    liveEquipment.shield.itemId = "wooden_shield";
    liveEquipment.shield.item = fixture.itemDefinitions.get("wooden_shield");
    liveEquipment.shield.quantity = 1;
    liveEquipment.arrows.itemId = "bronze_arrow";
    liveEquipment.arrows.item = fixture.itemDefinitions.get("bronze_arrow");
    liveEquipment.arrows.quantity = 50;

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", rangedRequest),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: "inventory_capacity_exceeded",
      }),
    );
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(liveEquipment.weapon.itemId).toBe("bronze_longsword");
    expect(liveEquipment.shield.itemId).toBe("wooden_shield");
    expect(fixture.rawInventory.items).toHaveLength(28);
  });

  it("applies a durable replay receipt exactly once to the live state", async () => {
    const fixture = createSwitchFixture({
      commit: async (request) => ({
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
        replayed: true,
        committed: request.committed,
      }),
    });
    const equipment = await initializeSwitchEquipment(fixture);

    await expect(
      equipment.switchOwnedCombatLoadout("agent-a", rangedRequest),
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, changed: true, replayed: true }),
    );
    expect(equipment.getPlayerEquipment("agent-a")?.weapon.itemId).toBe(
      "shortbow",
    );
    expect(
      fixture.rawInventory.items.filter(
        (item) => item.itemId === "bronze_longsword",
      ),
    ).toHaveLength(1);
    expect(
      fixture.rawInventory.items.filter((item) => item.itemId === "shortbow"),
    ).toHaveLength(0);
  });
});
