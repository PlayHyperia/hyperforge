/**
 * InventoryActionDispatcher Unit Tests
 *
 * Tests for centralized inventory action dispatching.
 *
 * Note: These tests use minimal mock objects for unit testing the dispatcher logic.
 * For full integration tests, use Playwright with real Hyperia instances.
 *
 * The mock -> World casts require `as unknown as` because the mock is a minimal
 * subset that doesn't structurally overlap with the full World type.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dispatchInventoryAction,
  type InventoryActionContext,
} from "../InventoryActionDispatcher";
import { EventType } from "@hyperforge/shared";

/**
 * Minimal world interface for testing the dispatcher
 * Only includes properties the dispatcher actually uses
 */
interface MockWorld {
  getPlayer: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  network: {
    send: ReturnType<typeof vi.fn>;
    dropItem?: ReturnType<typeof vi.fn>;
    applyOptimisticRemoval?: ReturnType<typeof vi.fn>;
  } | null;
  chat: {
    add: ReturnType<typeof vi.fn>;
  } | null;
}

/**
 * Helper to cast mock to InventoryActionContext["world"]
 * Required because MockWorld doesn't overlap with full World type
 */
function asWorld(mock: MockWorld): InventoryActionContext["world"] {
  return mock as unknown as InventoryActionContext["world"];
}

// Create mock world for testing
function createMockWorld(overrides: Partial<MockWorld> = {}): MockWorld {
  return {
    getPlayer: vi.fn(() => ({ id: "player1" })),
    emit: vi.fn(),
    network: {
      send: vi.fn(),
      dropItem: vi
        .fn()
        .mockReturnValue(
          "ground-item-drop:11111111-1111-4111-8111-111111111111",
        ),
      applyOptimisticRemoval: vi.fn(),
    },
    chat: {
      add: vi.fn(),
    },
    ...overrides,
  };
}

describe("InventoryActionDispatcher", () => {
  let mockWorld: MockWorld;

  beforeEach(() => {
    mockWorld = createMockWorld();
  });

  // ===========================================================================
  // EAT / DRINK ACTIONS
  // ===========================================================================

  describe("eat action", () => {
    it("sends useItem network message", () => {
      const result = dispatchInventoryAction("eat", {
        world: asWorld(mockWorld),
        itemId: "shrimp",
        slot: 0,
      });

      expect(result.success).toBe(true);
      // eat/drink/bury all route through server's useItem handler
      expect(mockWorld.network?.send).toHaveBeenCalledWith("useItem", {
        itemId: "shrimp",
        slot: 0,
      });
    });
  });

  describe("drink action", () => {
    it("sends useItem network message", () => {
      const result = dispatchInventoryAction("drink", {
        world: asWorld(mockWorld),
        itemId: "strength_potion",
        slot: 5,
      });

      expect(result.success).toBe(true);
      // eat/drink/bury all route through server's useItem handler
      expect(mockWorld.network?.send).toHaveBeenCalledWith("useItem", {
        itemId: "strength_potion",
        slot: 5,
      });
    });
  });

  // ===========================================================================
  // BURY ACTION
  // ===========================================================================

  describe("bury action", () => {
    it("sends useItem network message", () => {
      const result = dispatchInventoryAction("bury", {
        world: asWorld(mockWorld),
        itemId: "bones",
        slot: 3,
      });

      expect(result.success).toBe(true);
      // bury also routes through server's useItem handler (which detects bones)
      expect(mockWorld.network?.send).toHaveBeenCalledWith("useItem", {
        itemId: "bones",
        slot: 3,
      });
    });
  });

  // ===========================================================================
  // WIELD / WEAR ACTIONS
  // ===========================================================================

  describe("wield action", () => {
    it("sends equipItem network message", () => {
      const result = dispatchInventoryAction("wield", {
        world: asWorld(mockWorld),
        itemId: "bronze_shortsword",
        slot: 10,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.network?.send).toHaveBeenCalledWith("equipItem", {
        playerId: "player1",
        itemId: "bronze_shortsword",
        inventorySlot: 10,
      });
    });
  });

  describe("wear action", () => {
    it("sends equipItem network message", () => {
      const result = dispatchInventoryAction("wear", {
        world: asWorld(mockWorld),
        itemId: "bronze_platebody",
        slot: 15,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.network?.send).toHaveBeenCalledWith("equipItem", {
        playerId: "player1",
        itemId: "bronze_platebody",
        inventorySlot: 15,
      });
    });
  });

  // ===========================================================================
  // DROP ACTION
  // ===========================================================================

  describe("drop action", () => {
    it("uses dropItem method when available", () => {
      const result = dispatchInventoryAction("drop", {
        world: asWorld(mockWorld),
        itemId: "coins",
        slot: 20,
        quantity: 100,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.network?.dropItem).toHaveBeenCalledWith(
        "coins",
        20,
        100,
      );
    });

    it("fails closed instead of sending an identity-free fallback", () => {
      const worldWithoutDropItem = createMockWorld({
        network: {
          send: vi.fn(),
          applyOptimisticRemoval: vi.fn(),
        },
      });

      const result = dispatchInventoryAction("drop", {
        world: asWorld(worldWithoutDropItem),
        itemId: "logs",
        slot: 5,
        quantity: 10,
      });

      expect(result).toEqual({
        success: false,
        message: "Authoritative item dropping is unavailable",
      });
      expect(worldWithoutDropItem.network?.send).not.toHaveBeenCalled();
      expect(
        worldWithoutDropItem.network?.applyOptimisticRemoval,
      ).not.toHaveBeenCalled();
    });

    it("does not apply an optimistic removal when identity creation fails", () => {
      mockWorld.network?.dropItem?.mockImplementation(() => {
        throw new Error("secure identity unavailable");
      });

      const result = dispatchInventoryAction("drop", {
        world: asWorld(mockWorld),
        itemId: "logs",
        slot: 5,
        quantity: 10,
      });

      expect(result).toEqual({
        success: false,
        message: "Could not create an authoritative drop operation",
      });
      expect(mockWorld.network?.applyOptimisticRemoval).not.toHaveBeenCalled();
    });

    it("defaults quantity to 1", () => {
      const result = dispatchInventoryAction("drop", {
        world: asWorld(mockWorld),
        itemId: "bronze_shortsword",
        slot: 0,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.network?.dropItem).toHaveBeenCalledWith(
        "bronze_shortsword",
        0,
        1,
      );
    });
  });

  // ===========================================================================
  // EXAMINE ACTION
  // ===========================================================================

  describe("examine action", () => {
    it("emits UI_TOAST and adds chat message", () => {
      const result = dispatchInventoryAction("examine", {
        world: asWorld(mockWorld),
        itemId: "bronze_shortsword",
        slot: 0,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.emit).toHaveBeenCalledWith(
        EventType.UI_TOAST,
        expect.objectContaining({
          type: "info",
        }),
      );
      expect(mockWorld.chat?.add).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // USE ACTION
  // ===========================================================================

  describe("use action", () => {
    it("emits ITEM_ACTION_SELECTED event for targeting mode", () => {
      const result = dispatchInventoryAction("use", {
        world: asWorld(mockWorld),
        itemId: "tinderbox",
        slot: 2,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.emit).toHaveBeenCalledWith(
        EventType.ITEM_ACTION_SELECTED,
        {
          playerId: "player1",
          actionId: "use",
          itemId: "tinderbox",
          slot: 2,
        },
      );
    });
  });

  // ===========================================================================
  // CANCEL ACTION
  // ===========================================================================

  describe("cancel action", () => {
    it("returns success without any side effects", () => {
      const result = dispatchInventoryAction("cancel", {
        world: asWorld(mockWorld),
        itemId: "anything",
        slot: 0,
      });

      expect(result.success).toBe(true);
      expect(mockWorld.emit).not.toHaveBeenCalled();
      expect(mockWorld.network?.send).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe("error handling", () => {
    it("returns failure when no local player", () => {
      const worldWithoutPlayer = createMockWorld({
        getPlayer: vi.fn(() => null),
      });

      const result = dispatchInventoryAction("eat", {
        world: asWorld(worldWithoutPlayer),
        itemId: "shrimp",
        slot: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe("No local player");
    });

    it("warns for unhandled actions", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = dispatchInventoryAction("unknown_action", {
        world: asWorld(mockWorld),
        itemId: "test",
        slot: 0,
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe("Unhandled action: unknown_action");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unhandled action"),
      );

      consoleSpy.mockRestore();
    });

    it("does not warn for cancel action", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      dispatchInventoryAction("cancel", {
        world: asWorld(mockWorld),
        itemId: "test",
        slot: 0,
      });

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
