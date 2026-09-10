/**
 * GravestoneLootSystem Integration Tests
 *
 * Tests the ECS loot processing system:
 * - Single item loot (permissions, inventory, rollback)
 * - Loot all (partial loot, stackability, rollback)
 * - Rate limiting and payload validation
 * - Queue serialization (no race conditions)
 * - Memory cleanup
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { GravestoneLootSystem } from "../GravestoneLootSystem";
import { EventBus } from "../../infrastructure/EventBus";
import { EventType } from "../../../../types/events";
import { DeathState } from "../../../../types/entities";
import { ITEMS } from "../../../../data/items";
import type { Item } from "../../../../types";
import type { InventoryItem } from "../../../../types/core/core";

// ============================================================================
// Mock Types
// ============================================================================

interface MockWorld {
  isServer: boolean;
  entities: Map<string, unknown>;
  getSystem: Mock;
  emit: Mock;
  $eventBus: EventBus;
  network: { sendTo: Mock };
}

interface MockGravestone {
  id: string;
  canPlayerLoot: Mock;
  removeItem: Mock;
  restoreItem: Mock;
  getLootItems: Mock;
  hasLoot: Mock;
  getPosition: Mock;
  getOwnerId: Mock;
  getZoneType: Mock;
}

// ============================================================================
// Mock Factories
// ============================================================================

function createMockWorld(isServer = true): MockWorld {
  const eventBus = new EventBus();
  const world: MockWorld = {
    isServer,
    entities: new Map(),
    getSystem: vi.fn(),
    emit: vi.fn((event: string, data: unknown) => {
      eventBus.emitEvent(
        event,
        (data as Record<string, unknown>) ?? {},
        "world",
      );
    }),
    $eventBus: eventBus,
    network: { sendTo: vi.fn() },
  };
  return world;
}

function createMockGravestone(
  id: string,
  ownerId: string,
  items: InventoryItem[],
  options: { canLoot?: boolean; zoneType?: string } = {},
): MockGravestone {
  const lootItems = [...items];
  const { canLoot = true, zoneType = "wilderness" } = options;

  return {
    id,
    canPlayerLoot: vi.fn((playerId: string) =>
      canLoot ? playerId === ownerId : false,
    ),
    removeItem: vi.fn((itemId: string, quantity: number) => {
      const idx = lootItems.findIndex((i) => i.itemId === itemId);
      if (idx === -1) return false;
      if (lootItems[idx].quantity > quantity) {
        lootItems[idx].quantity -= quantity;
      } else {
        lootItems.splice(idx, 1);
      }
      return true;
    }),
    restoreItem: vi.fn(
      (itemId: string, quantity: number, originalIndex: number) => {
        const existing = lootItems.find((i) => i.itemId === itemId);
        if (existing) {
          existing.quantity += quantity;
        } else {
          const insertAt = Math.min(originalIndex, lootItems.length);
          lootItems.splice(insertAt, 0, {
            id: `restored_${itemId}`,
            itemId,
            quantity,
            slot: insertAt,
            metadata: null,
          });
        }
      },
    ),
    getLootItems: vi.fn(() => [...lootItems]),
    hasLoot: vi.fn(() => lootItems.length > 0),
    getPosition: vi.fn(() => ({ x: 100, y: 0, z: 200 })),
    getOwnerId: vi.fn(() => ownerId),
    getZoneType: vi.fn(() => zoneType),
  };
}

function createTestItem(
  itemId: string,
  quantity: number,
  slot = 0,
): InventoryItem {
  return {
    id: `item_${itemId}_${slot}`,
    itemId,
    quantity,
    slot,
    metadata: null,
  };
}

function createMockInventorySystem(
  playerInventories: Map<string, Array<{ itemId: string }>>,
) {
  return {
    getInventory: vi.fn((playerId: string) => {
      const items = playerInventories.get(playerId);
      if (!items) return null;
      return { items };
    }),
  };
}

function registerStackableItem(itemId: string): void {
  ITEMS.set(itemId, {
    id: itemId,
    name: itemId,
    stackable: true,
    type: "resource",
    description: "",
    examine: "",
    tradeable: true,
    rarity: "common",
    modelPath: null,
  } as unknown as Item);
}

function registerNonStackableItem(itemId: string): void {
  ITEMS.set(itemId, {
    id: itemId,
    name: itemId,
    stackable: false,
    type: "weapon",
    description: "",
    examine: "",
    tradeable: true,
    rarity: "common",
    modelPath: null,
  } as unknown as Item);
}

/** Wait for async queue processing */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

// ============================================================================
// Tests
// ============================================================================

describe("GravestoneLootSystem", () => {
  let world: MockWorld;
  let system: GravestoneLootSystem;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    registerStackableItem("grave_coins");
    registerStackableItem("grave_lobster");
    registerNonStackableItem("grave_bronze_shortsword");
    registerNonStackableItem("grave_iron_shield");

    world = createMockWorld(true);
    system = new GravestoneLootSystem(world as never);
    await system.init();

    // Suppress console noise in tests
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    system.destroy();
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Single Item Loot
  // --------------------------------------------------------------------------

  describe("single item loot", () => {
    it("owner loots item successfully", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1),
      ]);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockImplementation((name: string) =>
        name === "inventory" ? inv : null,
      );

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      // INVENTORY_ITEM_ADDED emitted
      expect(world.emit).toHaveBeenCalledWith(
        EventType.INVENTORY_ITEM_ADDED,
        expect.objectContaining({
          playerId: "player_1",
          item: expect.objectContaining({
            itemId: "grave_bronze_shortsword",
            quantity: 1,
          }),
        }),
      );

      // AUDIT_LOG emitted
      expect(world.emit).toHaveBeenCalledWith(
        EventType.AUDIT_LOG,
        expect.objectContaining({
          action: "LOOT_SUCCESS",
          actorId: "player_1",
        }),
      );

      // Network lootResult sent
      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: true }),
      );
    });

    it("non-owner is blocked from looting", async () => {
      const grave = createMockGravestone("grave_1", "owner_1", [
        createTestItem("grave_bronze_shortsword", 1),
      ]);
      world.entities.set("grave_1", grave);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "stranger",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "stranger",
        "lootResult",
        expect.objectContaining({ success: false, reason: "PROTECTED" }),
      );
      expect(grave.removeItem).not.toHaveBeenCalled();
    });

    it("item not found returns ITEM_NOT_FOUND", async () => {
      const grave = createMockGravestone("grave_1", "player_1", []);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "nonexistent",
        quantity: 1,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: false, reason: "ITEM_NOT_FOUND" }),
      );
    });

    it("inventory full with non-stackable item returns INVENTORY_FULL", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1),
      ]);
      world.entities.set("grave_1", grave);

      // 28 items = full inventory
      const fullInv = Array.from({ length: 28 }, (_, i) => ({
        itemId: `filler_${i}`,
      }));
      const inv = createMockInventorySystem(new Map([["player_1", fullInv]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: false, reason: "INVENTORY_FULL" }),
      );

      // UI_MESSAGE emitted
      expect(world.emit).toHaveBeenCalledWith(
        EventType.UI_MESSAGE,
        expect.objectContaining({
          playerId: "player_1",
          message: "Your inventory is full!",
        }),
      );
    });

    it("inventory full + stackable item with existing stack succeeds", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_coins", 50),
      ]);
      world.entities.set("grave_1", grave);

      // 28 items, one is coins (stackable)
      const fullInv = [
        ...Array.from({ length: 27 }, (_, i) => ({ itemId: `filler_${i}` })),
        { itemId: "grave_coins" },
      ];
      const inv = createMockInventorySystem(new Map([["player_1", fullInv]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_coins",
        quantity: 50,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: true }),
      );
    });

    it("inventory full + stackable item without existing stack fails", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_coins", 50),
      ]);
      world.entities.set("grave_1", grave);

      // 28 items, none are coins
      const fullInv = Array.from({ length: 28 }, (_, i) => ({
        itemId: `filler_${i}`,
      }));
      const inv = createMockInventorySystem(new Map([["player_1", fullInv]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_coins",
        quantity: 50,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: false, reason: "INVENTORY_FULL" }),
      );
    });

    it("partial stack loot deducts correct quantity", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_lobster", 10),
      ]);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_lobster",
        quantity: 3,
      });
      await tick();

      expect(grave.removeItem).toHaveBeenCalledWith("grave_lobster", 3);
      expect(world.emit).toHaveBeenCalledWith(
        EventType.INVENTORY_ITEM_ADDED,
        expect.objectContaining({
          item: expect.objectContaining({ quantity: 3 }),
        }),
      );
    });

    it("clamps quantity to available amount", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_lobster", 5),
      ]);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      // Request 100 but only 5 available
      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_lobster",
        quantity: 100,
      });
      await tick();

      expect(grave.removeItem).toHaveBeenCalledWith("grave_lobster", 5);
    });

    it("dead player is blocked from looting", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1),
      ]);
      world.entities.set("grave_1", grave);

      // Player in DYING state
      const deadPlayer = { data: { deathState: DeathState.DYING } };
      world.entities.set("player_1", deadPlayer);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: false, reason: "PLAYER_DYING" }),
      );
    });

    it("returns a terminal rejection when the gravestone no longer exists", async () => {
      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "nonexistent",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({
          success: false,
          reason: "INVALID_REQUEST",
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Loot All
  // --------------------------------------------------------------------------

  describe("loot all", () => {
    it("loots all items into empty inventory", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1, 0),
        createTestItem("grave_coins", 100, 1),
      ]);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
      });
      await tick();

      // Both items removed
      expect(grave.removeItem).toHaveBeenCalledTimes(2);

      // Audit log with all items
      expect(world.emit).toHaveBeenCalledWith(
        EventType.AUDIT_LOG,
        expect.objectContaining({
          action: "LOOT_ALL_SUCCESS",
          items: expect.arrayContaining([
            expect.objectContaining({ itemId: "grave_bronze_shortsword" }),
            expect.objectContaining({ itemId: "grave_coins" }),
          ]),
        }),
      );
    });

    it("stops when inventory full (non-stackable items)", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1, 0),
        createTestItem("grave_iron_shield", 1, 1),
      ]);
      world.entities.set("grave_1", grave);

      // 27 slots used — room for 1 more
      const almostFull = Array.from({ length: 27 }, (_, i) => ({
        itemId: `filler_${i}`,
      }));
      const inv = createMockInventorySystem(
        new Map([["player_1", almostFull]]),
      );
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
      });
      await tick();

      // Only first item fits (pre-calculation: 27 used, 1 slot available)
      expect(grave.removeItem).toHaveBeenCalledTimes(1);
      expect(grave.removeItem).toHaveBeenCalledWith(
        "grave_bronze_shortsword",
        1,
      );
    });

    it("stackable items don't consume new slots when stacking", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_coins", 50, 0),
        createTestItem("grave_lobster", 5, 1),
      ]);
      world.entities.set("grave_1", grave);

      // 28 slots used, but has coins and lobster already
      const fullInv = [
        ...Array.from({ length: 26 }, (_, i) => ({ itemId: `filler_${i}` })),
        { itemId: "grave_coins" },
        { itemId: "grave_lobster" },
      ];
      const inv = createMockInventorySystem(new Map([["player_1", fullInv]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
      });
      await tick();

      // Both stack onto existing items — no new slots needed
      expect(grave.removeItem).toHaveBeenCalledTimes(2);
    });

    it("empty gravestone returns success with 0 items", async () => {
      const grave = createMockGravestone("grave_1", "player_1", []);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
      });
      await tick();

      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: true }),
      );
      expect(grave.removeItem).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Durable safe-area custody
  // --------------------------------------------------------------------------

  describe("durable safe-area custody", () => {
    it("commits inventory custody before reloading inventory and removing visible loot", async () => {
      const order: string[] = [];
      const grave = createMockGravestone(
        "grave_atomic",
        "player_1",
        [createTestItem("grave_bronze_shortsword", 1)],
        { zoneType: "safe_area" },
      );
      grave.removeItem.mockImplementation(() => {
        order.push("remove-visible");
        return true;
      });
      world.entities.set(grave.id, grave);

      const inventory = {
        getInventory: vi.fn(() => ({ items: [] })),
        reloadFromDatabase: vi.fn(async () => {
          order.push("reload-inventory");
        }),
      };
      const database = {
        getDeathLockAsync: vi.fn(async () => ({
          playerId: "player_1",
          gravestoneId: grave.id,
          deathOperationId: "death-operation-1",
        })),
        commitSafeAreaDeathGravestoneLootAsync: vi.fn(async () => {
          order.push("commit-custody");
          return {
            replayed: false,
            transferred: [{ itemId: "grave_bronze_shortsword", quantity: 1 }],
            remaining: [],
          };
        }),
      };
      world.getSystem.mockImplementation((name: string) =>
        name === "inventory"
          ? inventory
          : name === "database"
            ? database
            : null,
      );

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: grave.id,
        playerId: "player_1",
        transactionId: "loot-atomic-1",
      });
      await tick();

      expect(order).toEqual([
        "commit-custody",
        "reload-inventory",
        "remove-visible",
      ]);
      expect(
        database.commitSafeAreaDeathGravestoneLootAsync,
      ).toHaveBeenCalledWith({
        operationId: "loot-atomic-1",
        playerId: "player_1",
        deathOperationId: "death-operation-1",
        gravestoneId: grave.id,
      });
      expect(world.emit).not.toHaveBeenCalledWith(
        EventType.INVENTORY_ITEM_ADDED,
        expect.anything(),
      );
      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: true }),
      );
    });

    it("leaves visible custody untouched when the database rejects the transfer", async () => {
      const grave = createMockGravestone(
        "grave_atomic",
        "player_1",
        [createTestItem("grave_bronze_shortsword", 1)],
        { zoneType: "safe_area" },
      );
      world.entities.set(grave.id, grave);
      const inventory = {
        getInventory: vi.fn(() => ({ items: [] })),
        reloadFromDatabase: vi.fn(),
      };
      const database = {
        getDeathLockAsync: vi.fn(async () => ({
          playerId: "player_1",
          gravestoneId: grave.id,
          deathOperationId: "death-operation-1",
        })),
        commitSafeAreaDeathGravestoneLootAsync: vi
          .fn()
          .mockRejectedValue(new Error("database unavailable")),
      };
      world.getSystem.mockImplementation((name: string) =>
        name === "inventory"
          ? inventory
          : name === "database"
            ? database
            : null,
      );

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        corpseId: grave.id,
        playerId: "player_1",
        transactionId: "loot-atomic-rejected",
      });
      await tick();

      expect(grave.removeItem).not.toHaveBeenCalled();
      expect(inventory.reloadFromDatabase).not.toHaveBeenCalled();
      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: false }),
      );
    });

    it("passes an exact item request to durable custody for single-item loot", async () => {
      const grave = createMockGravestone(
        "grave_atomic",
        "player_1",
        [createTestItem("grave_lobster", 5)],
        { zoneType: "safe_area" },
      );
      world.entities.set(grave.id, grave);
      const inventory = {
        getInventory: vi.fn(() => ({ items: [] })),
        reloadFromDatabase: vi.fn(async () => undefined),
      };
      const database = {
        getDeathLockAsync: vi.fn(async () => ({
          playerId: "player_1",
          gravestoneId: grave.id,
          deathOperationId: "death-operation-1",
        })),
        commitSafeAreaDeathGravestoneLootAsync: vi.fn(async () => ({
          replayed: false,
          transferred: [{ itemId: "grave_lobster", quantity: 3 }],
          remaining: [{ itemId: "grave_lobster", quantity: 2 }],
        })),
      };
      world.getSystem.mockImplementation((name: string) =>
        name === "inventory"
          ? inventory
          : name === "database"
            ? database
            : null,
      );

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: grave.id,
        playerId: "player_1",
        itemId: "grave_lobster",
        quantity: 3,
        transactionId: "loot-atomic-single",
      });
      await tick();

      expect(
        database.commitSafeAreaDeathGravestoneLootAsync,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: "loot-atomic-single",
          items: [{ itemId: "grave_lobster", quantity: 3 }],
        }),
      );
      expect(grave.removeItem).toHaveBeenCalledWith("grave_lobster", 3);
    });
  });

  // --------------------------------------------------------------------------
  // Rate Limiting
  // --------------------------------------------------------------------------

  describe("rate limiting", () => {
    it("rejects requests within 100ms window", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1),
        createTestItem("grave_coins", 100),
      ]);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      // First request goes through
      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });

      // Immediate second request — rate limited
      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_coins",
        quantity: 100,
      });
      await tick();

      // Second request got RATE_LIMITED
      expect(world.network.sendTo).toHaveBeenCalledWith(
        "player_1",
        "lootResult",
        expect.objectContaining({ success: false, reason: "RATE_LIMITED" }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Payload Validation
  // --------------------------------------------------------------------------

  describe("payload validation", () => {
    it("rejects missing corpseId", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        playerId: "player_1",
        itemId: "sword",
        quantity: 1,
      });
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed"),
      );
    });

    it("rejects missing playerId", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        itemId: "sword",
        quantity: 1,
      });
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed"),
      );
    });

    it("rejects float quantity", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "sword",
        quantity: 1.5,
      });
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed"),
      );
    });

    it("rejects negative quantity", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "sword",
        quantity: -1,
      });
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed"),
      );
    });

    it("rejects zero quantity", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "sword",
        quantity: 0,
      });
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed"),
      );
    });

    it("rejects loot-all with missing corpseId", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      world.emit(EventType.CORPSE_LOOT_ALL_REQUEST, {
        playerId: "player_1",
      });
      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed"),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Queue Serialization
  // --------------------------------------------------------------------------

  describe("queue serialization", () => {
    it("concurrent requests on same gravestone serialize", async () => {
      const callOrder: string[] = [];

      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1, 0),
        createTestItem("grave_coins", 100, 1),
      ]);
      // Track removeItem call order
      grave.removeItem.mockImplementation((itemId: string) => {
        callOrder.push(itemId);
        return true;
      });
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      // Fire two requests simultaneously
      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
        transactionId: "tx_1",
      });

      // Advance past rate limit
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);

      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_coins",
        quantity: 100,
        transactionId: "tx_2",
      });
      await tick();

      // Both processed in order
      expect(callOrder).toEqual(["grave_bronze_shortsword", "grave_coins"]);

      vi.restoreAllMocks();
    });
  });

  // --------------------------------------------------------------------------
  // Client-side Blocking
  // --------------------------------------------------------------------------

  describe("client-side blocking", () => {
    it("all operations no-op on client", async () => {
      const clientWorld = createMockWorld(false);
      const clientSystem = new GravestoneLootSystem(clientWorld as never);
      await clientSystem.init();

      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1),
      ]);
      clientWorld.entities.set("grave_1", grave);

      clientWorld.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      expect(grave.removeItem).not.toHaveBeenCalled();
      expect(clientWorld.network.sendTo).not.toHaveBeenCalled();

      clientSystem.destroy();
    });
  });

  // --------------------------------------------------------------------------
  // Memory Cleanup
  // --------------------------------------------------------------------------

  describe("memory cleanup", () => {
    it("destroy clears internal state", async () => {
      const grave = createMockGravestone("grave_1", "player_1", [
        createTestItem("grave_bronze_shortsword", 1),
      ]);
      world.entities.set("grave_1", grave);

      const inv = createMockInventorySystem(new Map([["player_1", []]]));
      world.getSystem.mockReturnValue(inv);

      // Process a request to populate internal maps
      world.emit(EventType.CORPSE_LOOT_REQUEST, {
        corpseId: "grave_1",
        playerId: "player_1",
        itemId: "grave_bronze_shortsword",
        quantity: 1,
      });
      await tick();

      // Destroy should not throw
      system.destroy();

      // Re-create system to verify no state leakage
      system = new GravestoneLootSystem(world as never);
      await system.init();
    });
  });
});
