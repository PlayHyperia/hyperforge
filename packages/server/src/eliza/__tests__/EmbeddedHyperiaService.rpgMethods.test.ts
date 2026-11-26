import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, ITEMS, processingDataProvider } from "@hyperforge/shared";
const { handleStoreBuyMock, handleStoreSellMock } = vi.hoisted(() => ({
  handleStoreBuyMock: vi.fn(),
  handleStoreSellMock: vi.fn(),
}));
vi.mock("../../systems/ServerNetwork/handlers/store.js", () => ({
  handleStoreBuy: handleStoreBuyMock,
  handleStoreSell: handleStoreSellMock,
}));
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService";

function createMockWorld() {
  const entities = new Map();
  const systems = new Map();
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  const world = {
    entities: {
      get: (id: string) => entities.get(id),
      values: () => entities.values(),
      add: vi.fn().mockReturnValue("new-entity-id"),
      items: entities,
      [Symbol.iterator]: () => entities.entries(),
    },
    getSystem: (name: string) => systems.get(name) ?? null,
    emit: vi.fn((event: string, data: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(data);
    }),
    on: vi.fn((event: string, listener: (data: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    off: vi.fn((event: string, listener: (data: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    isServer: true,
    network: null,
  };

  return { world, entities, systems };
}

function createActiveService() {
  const { world, entities, systems } = createMockWorld();
  entities.set("agent-1", {
    id: "agent-1",
    position: { x: 0, y: 0, z: 0 },
    data: { type: "player", position: [0, 0, 0] },
  });

  const service = new EmbeddedHyperiaService(
    world as never,
    "agent-1",
    "account-1",
    "TestAgent",
  );
  (service as unknown as { playerEntityId: string }).playerEntityId = "agent-1";
  (service as unknown as { isActive: boolean }).isActive = true;
  systems.set("database", {
    acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
    beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
    getProcessingActionCommitStatusAsync: vi
      .fn()
      .mockResolvedValue("committed"),
  });

  return { service, world, entities, systems };
}

async function emittedRequestId(
  world: ReturnType<typeof createMockWorld>["world"],
  eventType: string,
): Promise<string> {
  await Promise.resolve();
  const call = world.emit.mock.calls.find(([event]) => event === eventType);
  const requestId = (call?.[1] as { requestId?: unknown } | undefined)
    ?.requestId;
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return requestId as string;
}

describe("EmbeddedHyperiaService RPG methods", () => {
  beforeEach(() => {
    handleStoreBuyMock.mockReset();
    handleStoreSellMock.mockReset();
    vi.spyOn(processingDataProvider, "getBurnableLogIds").mockReturnValue(
      new Set(["logs"]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runecrafting", () => {
    it("uses pure essence at the exact nearby altar and normalizes rune item IDs", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [{ slot: 0, itemId: "pure_essence", quantity: 4 }],
        }),
      });
      const isPlayerInRange = vi.fn(() => true);
      entities.set("air-altar", {
        id: "air-altar",
        entityType: "runecrafting_altar",
        runeType: "air",
        isPlayerInRange,
        position: { x: 1, y: 0, z: 0 },
        data: { type: "object", position: [1, 0, 0] },
      });

      const pending = service.executeRunecraft("air_rune");
      const requestId = await emittedRequestId(
        world,
        EventType.RUNECRAFTING_INTERACT,
      );
      world.emit(EventType.RUNECRAFTING_COMPLETE, {
        playerId: "agent-1",
        runeType: "air",
        runeItemId: "air_rune",
        essenceConsumed: 4,
        runesProduced: 4,
        multiplier: 1,
        xpAwarded: 20,
        requestId,
      });
      const result = await pending;

      expect(result).toBe(true);
      expect(isPlayerInRange).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 });
      expect(world.emit).toHaveBeenCalledWith(EventType.RUNECRAFTING_INTERACT, {
        playerId: "agent-1",
        altarId: "air-altar",
        runeType: "air",
        requestId: expect.any(String),
      });
    });

    it("does not use a merely nearby altar for the wrong rune type", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [{ slot: 0, itemId: "rune_essence", quantity: 4 }],
        }),
      });
      entities.set("water-altar", {
        id: "water-altar",
        entityType: "runecrafting_altar",
        runeType: "water",
        isPlayerInRange: () => true,
      });

      expect(await service.executeRunecraft("air")).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("does not invoke an exact altar outside its configured range", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [{ slot: 0, itemId: "rune_essence", quantity: 4 }],
        }),
      });
      entities.set("air-altar", {
        id: "air-altar",
        entityType: "runecrafting_altar",
        runeType: "air",
        isPlayerInRange: () => false,
      });

      expect(await service.executeRunecraft("air")).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("requires either positive basic or pure essence", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [
            { slot: 0, itemId: "pure_essence", quantity: 0 },
            { slot: 1, itemId: "logs", quantity: 5 },
          ],
        }),
      });
      entities.set("air-altar", {
        id: "air-altar",
        entityType: "runecrafting_altar",
        runeType: "air",
        isPlayerInRange: () => true,
      });

      expect(await service.executeRunecraft("air")).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("skips a lookalike and invokes the exact live altar", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [{ slot: 0, itemId: "rune_essence", quantity: 4 }],
        }),
      });
      const lookalikeRangeCheck = vi.fn(() => true);
      entities.set("air-altar-display", {
        id: "air-altar-display",
        entityType: "object",
        runeType: "air",
        isPlayerInRange: lookalikeRangeCheck,
      });
      entities.set("air-altar-live", {
        id: "air-altar-live",
        entityType: "runecrafting_altar",
        runeType: "air",
        isPlayerInRange: () => true,
      });

      const pending = service.executeRunecraft("air");
      const requestId = await emittedRequestId(
        world,
        EventType.RUNECRAFTING_INTERACT,
      );
      world.emit(EventType.RUNECRAFTING_COMPLETE, {
        playerId: "agent-1",
        runeType: "air",
        essenceConsumed: 4,
        runesProduced: 4,
        requestId,
      });

      await expect(pending).resolves.toBe(true);
      expect(lookalikeRangeCheck).not.toHaveBeenCalled();
      expect(world.emit).toHaveBeenCalledWith(EventType.RUNECRAFTING_INTERACT, {
        playerId: "agent-1",
        altarId: "air-altar-live",
        runeType: "air",
        requestId: expect.any(String),
      });
    });

    it("does not invoke a runecrafting altar lookalike", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [{ slot: 0, itemId: "rune_essence", quantity: 4 }],
        }),
      });
      const isPlayerInRange = vi.fn(() => true);
      entities.set("air-altar-display", {
        id: "air-altar-display",
        entityType: "object",
        runeType: "air",
        isPlayerInRange,
      });

      await expect(service.executeRunecraft("air")).resolves.toBe(false);
      expect(isPlayerInRange).not.toHaveBeenCalled();
      expect(world.emit).not.toHaveBeenCalled();
    });
  });

  describe("tanning", () => {
    it("opens and uses only an exact physically authorized Tanner", async () => {
      const { service, world, entities, systems } = createActiveService();
      const canPlayerUseTanner = vi.fn(
        (_playerId: string, entityId: string, npcId: string) =>
          entityId === "tanner-live" && npcId === "tanner",
      );
      systems.set("tanning", {
        canPlayerUseTanner,
        canPlayerUseActiveTanner: () => true,
      });
      entities.set("tanner-live", {
        id: "tanner-live",
        position: { x: 1, y: 0, z: 1 },
        config: { npcType: "tanner", npcId: "tanner" },
        data: { type: "npc", position: [1, 0, 1] },
      });

      const pending = service.executeTan("cowhide", 2);
      const requestId = await emittedRequestId(
        world,
        EventType.TANNING_REQUEST,
      );
      world.emit(EventType.TANNING_COMPLETE, {
        playerId: "agent-1",
        inputItemId: "cowhide",
        outputItemId: "leather",
        totalTanned: 2,
        totalCost: 2,
        requestId,
      });
      await expect(pending).resolves.toBe(true);
      expect(canPlayerUseTanner).toHaveBeenCalledWith(
        "agent-1",
        "tanner-live",
        "tanner",
      );
      expect(world.emit).toHaveBeenNthCalledWith(
        1,
        EventType.TANNING_INTERACT,
        {
          playerId: "agent-1",
          npcId: "tanner",
          npcEntityId: "tanner-live",
        },
      );
      expect(world.emit).toHaveBeenNthCalledWith(2, EventType.TANNING_REQUEST, {
        playerId: "agent-1",
        inputItemId: "cowhide",
        quantity: 2,
        requestId: expect.any(String),
      });
    });

    it("fails closed when no exact authorized Tanner is usable", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("tanning", {
        canPlayerUseTanner: () => false,
        canPlayerUseActiveTanner: () => false,
      });
      entities.set("nearby-shopkeeper", {
        id: "nearby-shopkeeper",
        config: { npcType: "shopkeeper", npcId: "shopkeeper" },
      });
      entities.set("remote-tanner", {
        id: "remote-tanner",
        config: { npcType: "tanner", npcId: "tanner" },
      });

      await expect(service.executeTan("cowhide", 1)).resolves.toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("rejects an autonomy-bound tanning batch that cannot be replayed exactly", async () => {
      const { service, world } = createActiveService();
      await expect(
        service.executeTan(
          "cowhide",
          2,
          "44444444-4444-4444-8444-444444444444",
        ),
      ).resolves.toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });
  });

  describe("banking", () => {
    it("executeBankOpen fails closed when the bank target is not authoritative", async () => {
      const { service, world } = createActiveService();
      const result = await service.executeBankOpen("bank-town");
      expect(result).toMatchObject({
        success: false,
        action: "open",
        playerId: "agent-1",
        bankId: "bank-town",
        failureReason: "bank_target_invalid",
      });
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeBankDeposit validates itemId", async () => {
      const { service } = createActiveService();
      const result = await service.executeBankDeposit("", 1);
      expect(result).toMatchObject({
        success: false,
        action: "deposit",
        failureReason: "invalid_item",
      });
    });

    it("executeBankDeposit rejects when no authoritative bank was opened", async () => {
      const { service, world } = createActiveService();
      const previous = ITEMS.get("receipt_test_item");
      ITEMS.set("receipt_test_item", {
        id: "receipt_test_item",
        name: "Receipt Test Item",
        type: "resource",
      } as never);
      try {
        const result = await service.executeBankDeposit("receipt_test_item", 5);
        expect(result).toMatchObject({
          success: false,
          action: "deposit",
          itemId: "receipt_test_item",
          requestedQuantity: 5,
          failureReason: "bank_not_open",
        });
        expect(world.emit).not.toHaveBeenCalled();
      } finally {
        if (previous) ITEMS.set("receipt_test_item", previous);
        else ITEMS.delete("receipt_test_item");
      }
    });

    it("executeBankDepositAll rejects when durable storage is unavailable", async () => {
      const { service, world, entities } = createActiveService();
      entities.set("bank-nearby", {
        data: {
          type: "bank",
          name: "Nearby Bank",
          position: [2, 0, 0],
        },
      });
      const result = await service.executeBankDepositAll();
      expect(result).toMatchObject({
        success: false,
        action: "deposit_all",
        playerId: "agent-1",
        bankId: "bank-nearby",
        failureReason: "database_unavailable",
      });
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeBankDepositAll ignores nearby bank-name lookalikes", async () => {
      const { service, world, entities } = createActiveService();
      entities.set("decorative-bank-sign", {
        data: {
          type: "decoration",
          name: "Bank",
          position: [1, 0, 0],
        },
      });

      const result = await service.executeBankDepositAll();

      expect(result).toMatchObject({
        success: false,
        action: "deposit_all",
        failureReason: "bank_target_invalid",
      });
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeBankDepositAll does not open a bank outside two tiles", async () => {
      const { service, world, entities } = createActiveService();
      entities.set("bank-three-tiles-away", {
        data: {
          type: "bank",
          name: "Bank",
          position: [3, 0, 0],
        },
      });

      const result = await service.executeBankDepositAll();

      expect(result).toMatchObject({
        success: false,
        action: "deposit_all",
        bankId: "bank-three-tiles-away",
        failureReason: "bank_out_of_range",
      });
      expect(world.emit).not.toHaveBeenCalled();
    });
  });

  describe("shopping", () => {
    it("executeStoreBuy validates inputs", async () => {
      const { service } = createActiveService();
      expect(await service.executeStoreBuy("", "item", 1)).toBe(false);
      expect(await service.executeStoreBuy("store", "", 1)).toBe(false);
      expect(await service.executeStoreBuy("store", "item", 0)).toBe(false);
      expect(await service.executeStoreSell("", "item", 1)).toBe(false);
      expect(await service.executeStoreSell("store", "", 1)).toBe(false);
      expect(await service.executeStoreSell("store", "item", 1.5)).toBe(false);
    });

    it("executeStoreBuy fails closed without an exact runtime store target", async () => {
      const { service, world, systems } = createActiveService();
      systems.set("inventory", { addItemDirect: vi.fn() });
      const result = await service.executeStoreBuy(
        "store-1",
        "bronze_sword",
        1,
      );
      expect(result).toBe(false);
      expect(systems.get("inventory").addItemDirect).not.toHaveBeenCalled();
      expect(world.emit).not.toHaveBeenCalled();
      expect(handleStoreBuyMock).not.toHaveBeenCalled();
    });

    it("executeStoreBuy opens an exact nearby session and delegates to the secure handler", async () => {
      const { service, world, entities } = createActiveService();
      const openSession = vi.fn();
      const closeSession = vi.fn();
      Object.assign(world, {
        interactionSessionManager: { openSession, closeSession },
      });
      entities.set("npc-sword-store", {
        id: "npc-sword-store",
        position: { x: 2, y: 0, z: 2 },
        data: {
          id: "npc-sword-store",
          type: "npc",
          storeId: "sword_store",
          position: [2, 0, 2],
        },
      });
      handleStoreBuyMock.mockImplementation(async (socket, data) => {
        socket.send("inventoryUpdated", {
          playerId: "agent-1",
          items: [{ itemId: data.itemId, quantity: data.quantity }],
        });
        return {
          status: "committed",
          operationId: data.operationId ?? null,
          replayed: false,
        };
      });

      const result = await service.executeStoreBuy(
        "sword_store",
        "bronze_shortsword",
        1,
      );

      expect(result).toBe(true);
      expect(openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: "agent-1",
          sessionType: "store",
          targetEntityId: "npc-sword-store",
          targetStoreId: "sword_store",
        }),
      );
      expect(handleStoreBuyMock).toHaveBeenCalledWith(
        expect.objectContaining({ player: entities.get("agent-1") }),
        {
          storeId: "sword_store",
          itemId: "bronze_shortsword",
          quantity: 1,
        },
        world,
      );
      expect(closeSession).toHaveBeenCalledWith(
        "agent-1",
        "user_action",
        false,
      );
    });

    it("executeStoreBuy rejects a remote store before opening a session", async () => {
      const { service, world, entities } = createActiveService();
      const openSession = vi.fn();
      Object.assign(world, {
        interactionSessionManager: {
          openSession,
          closeSession: vi.fn(),
        },
      });
      entities.set("npc-remote-store", {
        id: "npc-remote-store",
        position: { x: 20, y: 0, z: 20 },
        data: {
          type: "npc",
          storeId: "sword_store",
          position: [20, 0, 20],
        },
      });

      expect(
        await service.executeStoreBuy("sword_store", "bronze_shortsword", 1),
      ).toBe(false);
      expect(openSession).not.toHaveBeenCalled();
      expect(handleStoreBuyMock).not.toHaveBeenCalled();
    });

    it("keeps an authoritative purchase unknown until live custody sync is confirmed", async () => {
      const { service, world, entities } = createActiveService();
      Object.assign(world, {
        interactionSessionManager: {
          openSession: vi.fn(),
          closeSession: vi.fn(),
        },
      });
      entities.set("npc-authoritative-store", {
        id: "npc-authoritative-store",
        position: { x: 1, y: 0, z: 1 },
        data: {
          type: "npc",
          storeId: "tool_store",
          position: [1, 0, 1],
        },
      });
      const operationId = "d78add75-64e6-48b3-9296-6db12a91b421";
      handleStoreBuyMock.mockResolvedValue({
        status: "committed",
        operationId,
        replayed: false,
      });

      await expect(
        service.executeAuthoritativeStoreBuy(
          "tool_store",
          "bronze_hatchet",
          1,
          operationId,
        ),
      ).resolves.toEqual({
        status: "unknown",
        operationId,
        replayed: false,
      });
      expect(handleStoreBuyMock).toHaveBeenCalledWith(
        expect.anything(),
        {
          storeId: "tool_store",
          itemId: "bronze_hatchet",
          quantity: 1,
          operationId,
        },
        world,
      );
    });

    it("executeStoreSell opens the exact nearby session and delegates to the secure handler", async () => {
      const { service, world, entities } = createActiveService();
      const openSession = vi.fn();
      const closeSession = vi.fn();
      Object.assign(world, {
        interactionSessionManager: { openSession, closeSession },
      });
      entities.set("npc-general-store", {
        id: "npc-general-store",
        position: { x: 2, y: 0, z: 2 },
        data: {
          id: "npc-general-store",
          type: "npc",
          storeId: "general_store",
          position: [2, 0, 2],
        },
      });
      handleStoreSellMock.mockImplementation(async (socket, data) => {
        socket.send("inventoryUpdated", {
          playerId: "agent-1",
          items: [],
          soldItemId: data.itemId,
        });
        return {
          status: "committed",
          operationId: data.operationId ?? null,
          replayed: false,
        };
      });

      const result = await service.executeStoreSell("general_store", "logs", 3);

      expect(result).toBe(true);
      expect(openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: "agent-1",
          sessionType: "store",
          targetEntityId: "npc-general-store",
          targetStoreId: "general_store",
        }),
      );
      expect(handleStoreSellMock).toHaveBeenCalledWith(
        expect.objectContaining({ player: entities.get("agent-1") }),
        { storeId: "general_store", itemId: "logs", quantity: 3 },
        world,
      );
      expect(closeSession).toHaveBeenCalledWith(
        "agent-1",
        "user_action",
        false,
      );
      expect(world.emit).not.toHaveBeenCalledWith(
        EventType.STORE_SELL,
        expect.anything(),
      );
    });
  });

  describe("crafting", () => {
    it("executeCook emits cooking event", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [
            {
              slot: 3,
              itemId: "raw_shrimp",
              quantity: 1,
              item: { id: "raw_shrimp", name: "Raw shrimp", type: "food" },
            },
          ],
        }),
      });
      const canPlayerUseCookingSource = vi.fn(() => true);
      systems.set("processing", { canPlayerUseCookingSource });
      entities.set("station_range_nearby", {
        id: "station_range_nearby",
        entityType: "range",
        data: {
          type: "object",
          name: "Cooking range",
          position: [1, 0, 0],
        },
      });
      const pending = service.executeCook("raw_shrimp");
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_COOKING_REQUEST,
      );
      world.emit(EventType.COOKING_COMPLETED, {
        playerId: "agent-1",
        rawItemId: "raw_shrimp",
        resultItemId: "shrimp",
        wasBurnt: false,
        xpGained: 10,
        requestId,
      });
      const result = await pending;
      expect(result).toBe(true);
      expect(canPlayerUseCookingSource).toHaveBeenCalledWith(
        "agent-1",
        "station_range_nearby",
        "range",
      );
      expect(world.emit).toHaveBeenCalled();
    });

    it("executeCook rejects a broad nearby-name match without exact authority", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [{ slot: 3, itemId: "raw_shrimp", quantity: 1 }],
        }),
      });
      systems.set("processing", {
        canPlayerUseCookingSource: vi.fn(() => false),
        getActiveFires: () => new Map(),
      });
      entities.set("decorative-cooking-fire", {
        id: "decorative-cooking-fire",
        entityType: "object",
        data: { type: "object", name: "Cooking range fire" },
      });

      expect(await service.executeCook("raw_shrimp")).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeSmelt binds an exact authorized furnace before the recipe", async () => {
      const { service, world, entities, systems } = createActiveService();
      const canPlayerUseFurnace = vi.fn(
        (_playerId: string, furnaceId: string) => furnaceId === "furnace-live",
      );
      systems.set("smelting", {
        canPlayerUseFurnace,
        canPlayerUseActiveFurnace: () => true,
      });
      entities.set("furnace-live", {
        id: "furnace-live",
        entityType: "furnace",
      });
      const pending = service.executeSmelt("bronze_bar");
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_SMELTING_REQUEST,
      );
      world.emit(EventType.SMELTING_COMPLETE, {
        playerId: "agent-1",
        barItemId: "bronze_bar",
        totalSmelted: 1,
        totalFailed: 0,
        totalXp: 6,
        requestId,
      });
      const result = await pending;

      expect(result).toBe(true);
      expect(canPlayerUseFurnace).toHaveBeenCalledWith(
        "agent-1",
        "furnace-live",
      );
      expect(world.emit).toHaveBeenNthCalledWith(
        1,
        EventType.SMELTING_INTERACT,
        { playerId: "agent-1", furnaceId: "furnace-live" },
      );
      expect(world.emit).toHaveBeenNthCalledWith(
        2,
        EventType.PROCESSING_SMELTING_REQUEST,
        {
          playerId: "agent-1",
          barItemId: "bronze_bar",
          furnaceId: "furnace-live",
          quantity: 1,
          requestId: expect.any(String),
        },
      );
    });

    it("executeSmelt rejects name lookalikes and unauthorized furnaces", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("smelting", {
        canPlayerUseFurnace: () => false,
        canPlayerUseActiveFurnace: () => false,
      });
      entities.set("display-spoof", {
        id: "display-spoof",
        name: "Furnace",
        entityType: "decoration",
      });
      entities.set("remote-furnace", {
        id: "remote-furnace",
        entityType: "furnace",
      });

      expect(await service.executeSmelt("bronze_bar")).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeSmith binds an exact authorized anvil before the recipe", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("smithing", {
        canPlayerUseAnvil: (_playerId: string, anvilId: string) =>
          anvilId === "anvil-live",
        canPlayerUseActiveAnvil: () => true,
      });
      entities.set("anvil-live", {
        id: "anvil-live",
        entityType: "anvil",
      });

      const pending = service.executeSmith("bronze_dagger");
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_SMITHING_REQUEST,
      );
      world.emit(EventType.SMITHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "bronze_dagger",
        outputItemId: "bronze_dagger",
        totalSmithed: 1,
        totalXp: 12,
        requestId,
      });
      await expect(pending).resolves.toBe(true);
      expect(world.emit).toHaveBeenNthCalledWith(
        1,
        EventType.SMITHING_INTERACT,
        { playerId: "agent-1", anvilId: "anvil-live" },
      );
      expect(world.emit).toHaveBeenNthCalledWith(
        2,
        EventType.PROCESSING_SMITHING_REQUEST,
        {
          playerId: "agent-1",
          recipeId: "bronze_dagger",
          anvilId: "anvil-live",
          quantity: 1,
          requestId: expect.any(String),
        },
      );
    });

    it("executeCraft binds furnace-only recipes to an exact furnace", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("crafting", {
        getRecipeStation: (id: string) =>
          id === "gold_ring" ? "furnace" : null,
        canPlayerUseCraftingFurnace: (_playerId: string, furnaceId: string) =>
          furnaceId === "furnace-live",
        canPlayerUseActiveCraftingFurnace: () => true,
      });
      entities.set("furnace-live", {
        id: "furnace-live",
        entityType: "furnace",
      });

      const pending = service.executeCraft("gold_ring", 1);
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_CRAFTING_REQUEST,
      );
      world.emit(EventType.CRAFTING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "gold_ring",
        outputItemId: "gold_ring",
        totalCrafted: 1,
        totalXp: 15,
        requestId,
      });
      await expect(pending).resolves.toBe(true);
      expect(world.emit).toHaveBeenNthCalledWith(
        1,
        EventType.CRAFTING_INTERACT,
        {
          playerId: "agent-1",
          triggerType: "furnace",
          stationId: "furnace-live",
        },
      );
      expect(world.emit).toHaveBeenNthCalledWith(
        2,
        EventType.PROCESSING_CRAFTING_REQUEST,
        {
          playerId: "agent-1",
          recipeId: "gold_ring",
          quantity: 1,
          requestId: expect.any(String),
        },
      );
    });

    it("waits for the exact fletching completion acknowledgement", async () => {
      const { service, world } = createActiveService();

      const pending = service.executeFletch("arrow_shaft", 1);
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_FLETCHING_REQUEST,
      );
      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "other-agent",
        recipeId: "arrow_shaft",
        outputItemId: "arrow_shaft",
        totalCrafted: 1,
        totalXp: 5,
        requestId,
      });
      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "shortbow_u",
        outputItemId: "shortbow_u",
        totalCrafted: 1,
        totalXp: 5,
        requestId,
      });
      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "arrow_shaft",
        outputItemId: "arrow_shaft",
        totalCrafted: 1,
        totalXp: 5,
        requestId: "00000000-0000-4000-8000-000000000001",
      });

      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "arrow_shaft",
        outputItemId: "arrow_shaft",
        totalCrafted: 1,
        totalXp: 5,
        requestId,
      });
      await expect(pending).resolves.toBe(true);
      expect(world.off).toHaveBeenCalledWith(
        EventType.FLETCHING_COMPLETE,
        expect.any(Function),
      );
    });

    it("ends immediately only for the exact correlated rejection", async () => {
      const { service, world, systems } = createActiveService();
      systems.set("database", {
        acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
        beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
        getProcessingActionCommitStatusAsync: vi
          .fn()
          .mockResolvedValue("rejected"),
      });
      const pending = service.executeFletch("arrow_shaft", 1);
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_FLETCHING_REQUEST,
      );

      world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "agent-1",
        requestId: "00000000-0000-4000-8000-000000000001",
        skill: "fletching",
        reason: "resources_unavailable",
        retryable: false,
      });
      world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "other-agent",
        requestId,
        skill: "fletching",
        reason: "resources_unavailable",
        retryable: false,
      });
      world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "agent-1",
        requestId,
        skill: "crafting",
        reason: "resources_unavailable",
        retryable: false,
      });

      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "agent-1",
        requestId,
        skill: "fletching",
        reason: "resources_unavailable",
        retryable: false,
      });
      await expect(pending).resolves.toBe(false);
      expect(world.off).toHaveBeenCalledWith(
        EventType.PROCESSING_REQUEST_REJECTED,
        expect.any(Function),
      );
    });

    it("reconciles a zero-work completion packet against durable rejection", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("smelting", {
        canPlayerUseFurnace: () => true,
        canPlayerUseActiveFurnace: () => true,
      });
      const getProcessingActionCommitStatusAsync = vi
        .fn()
        .mockResolvedValue("rejected");
      systems.set("database", {
        acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
        beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
        getProcessingActionCommitStatusAsync,
      });
      entities.set("furnace-live", {
        id: "furnace-live",
        entityType: "furnace",
      });

      const pending = service.executeSmelt("bronze_bar");
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_SMELTING_REQUEST,
      );
      world.emit(EventType.SMELTING_COMPLETE, {
        playerId: "agent-1",
        barItemId: "bronze_bar",
        totalSmelted: 0,
        totalFailed: 0,
        totalXp: 0,
        requestId,
      });

      await expect(pending).resolves.toBe(false);
      expect(getProcessingActionCommitStatusAsync).toHaveBeenCalledWith(
        "agent-1",
        `processing-request:smelting:${requestId}`,
      );
    });

    it("preserves committed truth across a zero-work completion packet", async () => {
      const { service, world, entities, systems } = createActiveService();
      systems.set("smelting", {
        canPlayerUseFurnace: () => true,
        canPlayerUseActiveFurnace: () => true,
      });
      systems.set("database", {
        acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
        beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
        getProcessingActionCommitStatusAsync: vi
          .fn()
          .mockResolvedValue("committed"),
      });
      entities.set("furnace-live", {
        id: "furnace-live",
        entityType: "furnace",
      });

      const pending = service.executeSmelt("bronze_bar");
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_SMELTING_REQUEST,
      );
      world.emit(EventType.SMELTING_COMPLETE, {
        playerId: "agent-1",
        barItemId: "bronze_bar",
        totalSmelted: 0,
        totalFailed: 0,
        totalXp: 0,
        requestId,
      });

      await expect(pending).resolves.toBe(true);
    });

    it("preserves committed truth across a late rejection packet", async () => {
      const { service, world, systems } = createActiveService();
      systems.set("database", {
        acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
        beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
        getProcessingActionCommitStatusAsync: vi
          .fn()
          .mockResolvedValue("committed"),
      });
      const pending = service.executeFletch("arrow_shaft", 1);
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_FLETCHING_REQUEST,
      );

      world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "agent-1",
        requestId,
        skill: "fletching",
        reason: "busy",
        retryable: true,
      });

      await expect(pending).resolves.toBe(true);
    });

    it("awaits the durable quest projection before exposing a committed action", async () => {
      const { service, world, systems } = createActiveService();
      let releaseProjection!: () => void;
      const reconcileDurableProgress = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseProjection = resolve;
          }),
      );
      systems.set("quest", { reconcileDurableProgress });

      const pending = service.executeFletch("arrow_shaft", 1);
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_FLETCHING_REQUEST,
      );
      world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
        playerId: "agent-1",
        requestId,
        skill: "fletching",
        phase: "committed",
      });

      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(reconcileDurableProgress).toHaveBeenCalledWith("agent-1");
      expect(settled).toBe(false);

      releaseProjection();
      await expect(pending).resolves.toBe(true);
    });

    it("uses an exact caller-supplied autonomy attempt as the durable request identity", async () => {
      const { service, world, systems } = createActiveService();
      const attemptId = "33333333-3333-4333-8333-333333333333";
      const database = systems.get("database") as {
        beginProcessingRequestAsync: ReturnType<typeof vi.fn>;
      };

      const pending = service.executeFletch("arrow_shaft", 1, attemptId);
      expect(
        await emittedRequestId(world, EventType.PROCESSING_FLETCHING_REQUEST),
      ).toBe(attemptId);
      expect(database.beginProcessingRequestAsync).toHaveBeenCalledWith(
        "agent-1",
        `processing-request:fletching:${attemptId}`,
        attemptId,
        "fletching",
        {
          skill: "fletching",
          recipeId: "arrow_shaft",
          quantity: 1,
        },
      );

      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "arrow_shaft",
        outputItemId: "arrow_shaft",
        totalCrafted: 1,
        totalXp: 5,
        requestId: attemptId,
      });
      await expect(pending).resolves.toBe(true);
    });

    it("preserves committed truth and single-flight authority across a transient terminal acknowledgement loss", async () => {
      vi.useFakeTimers();
      try {
        const { service, world, systems } = createActiveService();
        const firstAttemptId = "55555555-5555-4555-8555-555555555555";
        const secondAttemptId = "66666666-6666-4666-8666-666666666666";
        const acknowledgeProcessingRequestAsync = vi
          .fn()
          .mockRejectedValueOnce(new Error("database response lost"))
          .mockResolvedValue(true);
        const beginProcessingRequestAsync = vi
          .fn()
          .mockResolvedValueOnce("accepted")
          .mockResolvedValueOnce("busy");
        systems.set("database", {
          acknowledgeProcessingRequestAsync,
          beginProcessingRequestAsync,
          getProcessingActionCommitStatusAsync: vi
            .fn()
            .mockResolvedValue("committed"),
        });

        const committed = service.executeFletch(
          "arrow_shaft",
          1,
          firstAttemptId,
        );
        expect(
          await emittedRequestId(world, EventType.PROCESSING_FLETCHING_REQUEST),
        ).toBe(firstAttemptId);
        world.emit(EventType.FLETCHING_COMPLETE, {
          playerId: "agent-1",
          recipeId: "arrow_shaft",
          outputItemId: "arrow_shaft",
          totalCrafted: 1,
          totalXp: 5,
          requestId: firstAttemptId,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(acknowledgeProcessingRequestAsync).toHaveBeenCalledTimes(1);

        await expect(
          service.executeFletch("shortbow_u", 1, secondAttemptId),
        ).resolves.toBe(false);
        expect(beginProcessingRequestAsync).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5_000);
        await expect(committed).resolves.toBe(true);
        expect(acknowledgeProcessingRequestAsync).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("wakes terminal acknowledgement retry on service stop without downgrading committed truth", async () => {
      const { service, world, systems } = createActiveService();
      const attemptId = "77777777-7777-4777-8777-777777777777";
      const acknowledgeProcessingRequestAsync = vi
        .fn()
        .mockRejectedValue(new Error("database unavailable"));
      systems.set("database", {
        acknowledgeProcessingRequestAsync,
        beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
        getProcessingActionCommitStatusAsync: vi
          .fn()
          .mockResolvedValue("committed"),
      });

      const committed = service.executeFletch("arrow_shaft", 1, attemptId);
      expect(
        await emittedRequestId(world, EventType.PROCESSING_FLETCHING_REQUEST),
      ).toBe(attemptId);
      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "arrow_shaft",
        outputItemId: "arrow_shaft",
        totalCrafted: 1,
        totalXp: 5,
        requestId: attemptId,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(acknowledgeProcessingRequestAsync).toHaveBeenCalledOnce();

      await service.stop();
      await expect(committed).resolves.toBe(true);
    });

    it("rejects a malformed caller-supplied processing identity before submission", async () => {
      const { service, world, systems } = createActiveService();
      const database = systems.get("database") as {
        beginProcessingRequestAsync: ReturnType<typeof vi.fn>;
      };

      await expect(
        service.executeFletch("arrow_shaft", 1, "not-an-attempt"),
      ).resolves.toBe(false);
      expect(database.beginProcessingRequestAsync).not.toHaveBeenCalled();
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("serializes processing actions and fails closed after a durable receipt miss", async () => {
      vi.useFakeTimers();
      try {
        const { service, world, systems } = createActiveService();
        const getStatus = vi.fn().mockResolvedValue("not_found");
        systems.set("database", {
          acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
          beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
          getProcessingActionCommitStatusAsync: getStatus,
        });
        const pending = service.executeFletch("arrow_shaft", 1);
        const requestId = await emittedRequestId(
          world,
          EventType.PROCESSING_FLETCHING_REQUEST,
        );

        await expect(service.executeFletch("shortbow_u", 1)).resolves.toBe(
          false,
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(pending).resolves.toBe(false);
        expect(getStatus).toHaveBeenCalledWith(
          "agent-1",
          `processing-request:fletching:${requestId}`,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("recovers a committed action after its live completion signal is lost", async () => {
      vi.useFakeTimers();
      try {
        const { service, systems } = createActiveService();
        systems.set("database", {
          acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
          beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
          getProcessingActionCommitStatusAsync: vi
            .fn()
            .mockResolvedValue("committed"),
        });

        const pending = service.executeFletch("arrow_shaft", 1);
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(pending).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes the exact request after a replacement server reports interruption", async () => {
      vi.useFakeTimers();
      try {
        const { service, world, systems } = createActiveService();
        const beginProcessingRequestAsync = vi
          .fn()
          .mockResolvedValue("accepted");
        systems.set("database", {
          acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
          beginProcessingRequestAsync,
          getProcessingActionCommitStatusAsync: vi
            .fn()
            .mockResolvedValueOnce("interrupted")
            .mockResolvedValue("committed"),
        });

        const pending = service.executeFletch("arrow_shaft", 1);
        const requestId = await emittedRequestId(
          world,
          EventType.PROCESSING_FLETCHING_REQUEST,
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await Promise.resolve();

        const submissions = world.emit.mock.calls.filter(
          ([event]) => event === EventType.PROCESSING_FLETCHING_REQUEST,
        );
        expect(submissions).toHaveLength(2);
        expect(submissions[0]?.[1]).toEqual(submissions[1]?.[1]);
        expect(beginProcessingRequestAsync).toHaveBeenCalledTimes(2);
        expect(beginProcessingRequestAsync).toHaveBeenNthCalledWith(
          2,
          "agent-1",
          `processing-request:fletching:${requestId}`,
          requestId,
          "fletching",
          {
            skill: "fletching",
            recipeId: "arrow_shaft",
            quantity: 1,
          },
        );

        world.emit(EventType.FLETCHING_COMPLETE, {
          playerId: "agent-1",
          recipeId: "arrow_shaft",
          outputItemId: "arrow_shaft",
          totalCrafted: 1,
          totalXp: 5,
          requestId,
        });
        await expect(pending).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconstructs an exact durable command after the embedded service itself restarts", async () => {
      const { service, world, systems } = createActiveService();
      const requestId = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";
      const envelope = {
        skill: "fletching" as const,
        recipeId: "arrow_shaft",
        quantity: 1 as const,
      };
      const getRecoverableProcessingRequestAsync = vi
        .fn()
        .mockResolvedValueOnce({
          requestId,
          skill: "fletching",
          status: "interrupted",
          envelope,
          acceptedAt: 100,
          heartbeatAt: 200,
          terminalAt: null,
        })
        .mockResolvedValueOnce(null);
      const acknowledgeProcessingRequestAsync = vi.fn().mockResolvedValue(true);
      const beginProcessingRequestAsync = vi.fn().mockResolvedValue("accepted");
      systems.set("database", {
        acknowledgeProcessingRequestAsync,
        beginProcessingRequestAsync,
        getRecoverableProcessingRequestAsync,
      });

      const recovery = (
        service as unknown as {
          recoverDurableProcessingRequest: () => Promise<void>;
        }
      ).recoverDurableProcessingRequest();
      await vi.waitFor(() => {
        expect(world.emit).toHaveBeenCalledWith(
          EventType.PROCESSING_FLETCHING_REQUEST,
          {
            playerId: "agent-1",
            recipeId: "arrow_shaft",
            quantity: 1,
            requestId,
          },
        );
      });

      world.emit(EventType.FLETCHING_COMPLETE, {
        playerId: "agent-1",
        recipeId: "arrow_shaft",
        outputItemId: "arrow_shaft",
        totalCrafted: 1,
        totalXp: 5,
        requestId,
      });
      await expect(recovery).resolves.toBeUndefined();
      expect(beginProcessingRequestAsync).toHaveBeenCalledWith(
        "agent-1",
        `processing-request:fletching:${requestId}`,
        requestId,
        "fletching",
        envelope,
      );
      expect(acknowledgeProcessingRequestAsync).toHaveBeenCalledWith(
        "agent-1",
        requestId,
      );
      expect(getRecoverableProcessingRequestAsync).toHaveBeenCalledTimes(2);
    });

    it("ignores a stale receipt miss after newer authority progress", async () => {
      vi.useFakeTimers();
      try {
        const { service, world, systems } = createActiveService();
        let resolveStatus!: (status: "not_found") => void;
        const pendingStatus = new Promise<"not_found">((resolve) => {
          resolveStatus = resolve;
        });
        const getStatus = vi
          .fn()
          .mockImplementationOnce(() => pendingStatus)
          .mockResolvedValue("committed");
        systems.set("database", {
          acknowledgeProcessingRequestAsync: vi.fn().mockResolvedValue(true),
          beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
          getProcessingActionCommitStatusAsync: getStatus,
        });

        const pending = service.executeFletch("arrow_shaft", 1);
        const requestId = await emittedRequestId(
          world,
          EventType.PROCESSING_FLETCHING_REQUEST,
        );
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getStatus).toHaveBeenCalledTimes(1);

        world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
          playerId: "agent-1",
          requestId,
          skill: "fletching",
          phase: "reconciling",
        });
        resolveStatus("not_found");
        await Promise.resolve();
        await Promise.resolve();

        let settled = false;
        void pending.finally(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        world.emit(EventType.FLETCHING_COMPLETE, {
          playerId: "agent-1",
          recipeId: "arrow_shaft",
          outputItemId: "arrow_shaft",
          totalCrafted: 1,
          totalXp: 5,
          requestId,
        });
        await expect(pending).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects correlated multi-action crafting and fletching batches", async () => {
      const { service } = createActiveService();
      await expect(service.executeCraft("leather_gloves", 2)).resolves.toBe(
        false,
      );
      await expect(service.executeFletch("arrow_shaft", 2)).resolves.toBe(
        false,
      );
    });

    it("resets the inactivity watchdog only for exact authority progress", async () => {
      vi.useFakeTimers();
      try {
        const { service, world } = createActiveService();
        const pending = service.executeFletch("arrow_shaft", 1);
        const requestId = await emittedRequestId(
          world,
          EventType.PROCESSING_FLETCHING_REQUEST,
        );

        await vi.advanceTimersByTimeAsync(20_000);
        world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
          playerId: "other-agent",
          requestId,
          skill: "fletching",
          phase: "working",
        });
        world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
          playerId: "agent-1",
          requestId,
          skill: "crafting",
          phase: "working",
        });
        world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
          playerId: "agent-1",
          requestId,
          skill: "fletching",
          phase: "reconciling",
        });
        await vi.advanceTimersByTimeAsync(20_000);

        let settled = false;
        void pending.finally(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        world.emit(EventType.FLETCHING_COMPLETE, {
          playerId: "agent-1",
          recipeId: "arrow_shaft",
          outputItemId: "arrow_shaft",
          totalCrafted: 1,
          totalXp: 5,
          requestId,
        });
        await expect(pending).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats a correlated committed progress receipt as terminal", async () => {
      const { service, world, systems } = createActiveService();
      const acknowledgeProcessingRequestAsync = vi.fn().mockResolvedValue(true);
      systems.set("database", {
        acknowledgeProcessingRequestAsync,
        beginProcessingRequestAsync: vi.fn().mockResolvedValue("accepted"),
      });

      const pending = service.executeFletch("arrow_shaft", 1);
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_FLETCHING_REQUEST,
      );
      world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
        playerId: "agent-1",
        requestId,
        skill: "fletching",
        phase: "committed",
      });

      await expect(pending).resolves.toBe(true);
      expect(acknowledgeProcessingRequestAsync).toHaveBeenCalledWith(
        "agent-1",
        requestId,
      );
      expect(
        world.emit.mock.calls.filter(
          ([event]) => event === EventType.PROCESSING_FLETCHING_REQUEST,
        ),
      ).toHaveLength(1);
    });

    it("executeFiremake emits firemaking event", async () => {
      const { service, world, systems } = createActiveService();
      systems.set("inventory", {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "tinderbox",
              quantity: 1,
              item: { id: "tinderbox", name: "Tinderbox", type: "tool" },
            },
            {
              slot: 1,
              itemId: "logs",
              quantity: 1,
              item: { id: "logs", name: "Logs", type: "resource" },
            },
          ],
        }),
      });
      systems.set("processing", { canPlayerLightFireHere: () => true });
      const pending = service.executeFiremake();
      const requestId = await emittedRequestId(
        world,
        EventType.PROCESSING_FIREMAKING_REQUEST,
      );
      world.emit(EventType.FIRE_CREATED, {
        fireId: "fire-agent-1",
        playerId: "agent-1",
        position: { x: 0, y: 0, z: 0 },
        createdAt: 1_000,
        expiresAt: 61_000,
        requestId,
      });
      const result = await pending;
      expect(result).toBe(true);
      expect(world.emit).toHaveBeenCalled();
    });
  });

  describe("quests", () => {
    it("executeNpcInteract validates npcId", async () => {
      const { service } = createActiveService();
      expect(await service.executeNpcInteract("")).toBe(false);
    });

    it("executeNpcInteract emits event", async () => {
      const { service, world } = createActiveService();
      const result = await service.executeNpcInteract("npc-guard", "talk");
      expect(result).toBe(true);
      expect(world.emit).toHaveBeenCalled();
    });
  });

  describe("combat advanced", () => {
    it("holds an exact preparation combat fence until its owner releases it", () => {
      const { service, systems } = createActiveService();
      const beginDuelPreparationCombatFence = vi.fn(() => true);
      const endDuelPreparationCombatFence = vi.fn(() => true);
      systems.set("combat", {
        beginDuelPreparationCombatFence,
        endDuelPreparationCombatFence,
      });

      expect(service.beginDuelPreparationCombatFence("preparation-a")).toBe(
        true,
      );
      expect(service.beginDuelPreparationCombatFence("preparation-a")).toBe(
        true,
      );
      expect(service.beginDuelPreparationCombatFence("preparation-b")).toBe(
        false,
      );
      expect(beginDuelPreparationCombatFence).toHaveBeenCalledTimes(2);

      service.revokeDuelPreparationBankAccess("preparation-a");
      expect(endDuelPreparationCombatFence).not.toHaveBeenCalled();
      expect(service.endDuelPreparationCombatFence("preparation-b")).toBe(
        false,
      );
      expect(service.endDuelPreparationCombatFence("preparation-a")).toBe(true);
      expect(endDuelPreparationCombatFence).toHaveBeenCalledOnce();
      expect(endDuelPreparationCombatFence).toHaveBeenCalledWith(
        "agent-1",
        "preparation-a",
      );
      expect(service.endDuelPreparationCombatFence("preparation-a")).toBe(
        false,
      );
    });

    it("fails closed when no combat system can install the fence", () => {
      const { service } = createActiveService();

      expect(service.beginDuelPreparationCombatFence("preparation-a")).toBe(
        false,
      );
    });

    it("waits for projectile custody to settle before preparation can inspect the bank", async () => {
      const { service, systems, entities } = createActiveService();
      let arrowQuantity = 500;
      let runeQuantity = 500;
      systems.set("equipment", {
        getPlayerEquipment: () => ({
          weapon: { itemId: "shortbow", quantity: 1 },
          arrows: { itemId: "bronze_arrow", quantity: arrowQuantity },
        }),
      });
      systems.set("inventory", {
        getInventory: () => ({
          items: [
            {
              slot: 0,
              itemId: "fire_rune",
              quantity: runeQuantity,
              item: { id: "fire_rune", name: "Fire rune", type: "misc" },
            },
          ],
        }),
      });
      expect(service.getGameState()).toMatchObject({
        equipment: {
          arrows: { itemId: "bronze_arrow", quantity: 500 },
        },
        inventory: [{ itemId: "fire_rune", quantity: 500 }],
      });
      let releaseCustody!: () => void;
      const pendingCustody = new Promise<void>((resolve) => {
        releaseCustody = resolve;
      });
      const forceEndCombat = vi.fn();
      const waitForProjectileCustodySettlements = vi.fn(() => pendingCustody);
      systems.set("combat", {
        forceEndCombat,
        waitForProjectileCustodySettlements,
      });

      let stopped = false;
      const stop = service.executeStop().then((result) => {
        stopped = true;
        return result;
      });
      await vi.waitFor(() => expect(forceEndCombat).toHaveBeenCalledOnce());

      expect(waitForProjectileCustodySettlements).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      expect(entities.get("agent-1").data.inCombat).not.toBe(false);

      arrowQuantity = 498;
      runeQuantity = 496;
      releaseCustody();
      await expect(stop).resolves.toBe(true);
      expect(entities.get("agent-1").data).toMatchObject({
        combatTarget: null,
        inCombat: false,
        ct: null,
        c: false,
        attackTarget: null,
      });
      expect(service.getGameState()).toMatchObject({
        equipment: {
          arrows: { itemId: "bronze_arrow", quantity: 498 },
        },
        inventory: [{ itemId: "fire_rune", quantity: 496 }],
      });
    });

    it("executeEquip awaits and returns the authoritative equipment receipt", async () => {
      const { service, systems, world } = createActiveService();
      const receipt = {
        ok: true,
        playerId: "agent-1",
        itemId: "shortbow",
        slot: "weapon",
        changed: true,
      } as const;
      const equipOwnedItem = vi.fn(async () => receipt);
      systems.set("equipment", { equipOwnedItem });

      await expect(service.executeEquip("shortbow")).resolves.toEqual(receipt);
      expect(equipOwnedItem).toHaveBeenCalledWith("agent-1", "shortbow");
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeEquip fails closed when the authoritative equipment API is absent", async () => {
      const { service } = createActiveService();

      await expect(service.executeEquip("shortbow")).resolves.toEqual({
        ok: false,
        playerId: "agent-1",
        itemId: "shortbow",
        slot: null,
        changed: false,
        reason: "equipment_system_unavailable",
      });
    });

    it("executeUnequipOwned awaits and returns the authoritative conserved receipt", async () => {
      const { service, systems, world } = createActiveService();
      const receipt = {
        ok: true,
        playerId: "agent-1",
        itemId: "metal_body",
        slot: "body",
        changed: true,
      } as const;
      const unequipOwnedItem = vi.fn(async () => receipt);
      systems.set("equipment", { unequipOwnedItem });

      await expect(service.executeUnequipOwned("body")).resolves.toEqual(
        receipt,
      );
      expect(unequipOwnedItem).toHaveBeenCalledWith("agent-1", "body");
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeUnequipOwned fails closed when the authoritative equipment API is absent", async () => {
      const { service } = createActiveService();

      await expect(service.executeUnequipOwned("body")).resolves.toEqual({
        ok: false,
        playerId: "agent-1",
        itemId: "",
        slot: "body",
        changed: false,
        reason: "equipment_system_unavailable",
      });
    });

    it("executeDuelPreparationPlan requires and forwards the exact private capability", async () => {
      const { service, systems } = createActiveService();
      const preparationId = "3c477a8d-ae92-4a0e-88ec-7b6fa779e761";
      (service as unknown as { activeBankId: string }).activeBankId =
        `duel-preparation:${preparationId}`;
      (
        service as unknown as { activeBankPreparationId: string }
      ).activeBankPreparationId = preparationId;
      const request = {
        operationId: "f9771187-7443-4612-bf51-f2db8903dd77",
        preparationId,
        expectedBank: [
          { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
        ],
        committed: {
          bank: [],
          inventory: [],
          equipment: [{ slotType: "weapon", itemId: "shortbow", quantity: 1 }],
          selectedSpell: null,
        },
        recoveryEvidence: { planningSource: "deterministic" },
      };
      const receipt = {
        ok: true,
        playerId: "agent-1",
        operationId: request.operationId,
        preparationId,
        requestFingerprint: "fingerprint",
        changed: true,
        replayed: false,
        committed: request.committed,
        recoveryEvidence: request.recoveryEvidence,
      } as const;
      const commitOwnedDuelPreparationPlan = vi.fn(async () => receipt);
      systems.set("equipment", { commitOwnedDuelPreparationPlan });

      await expect(
        service.executeDuelPreparationPlan(request),
      ).resolves.toEqual(receipt);
      expect(commitOwnedDuelPreparationPlan).toHaveBeenCalledWith(
        "agent-1",
        request,
      );
    });

    it("executeDuelPreparationPlan rejects a stale process-local capability", async () => {
      const { service, systems } = createActiveService();
      const commitOwnedDuelPreparationPlan = vi.fn();
      systems.set("equipment", { commitOwnedDuelPreparationPlan });
      const preparationId = "3c477a8d-ae92-4a0e-88ec-7b6fa779e761";

      await expect(
        service.executeDuelPreparationPlan({
          operationId: "f9771187-7443-4612-bf51-f2db8903dd77",
          preparationId,
          expectedBank: [],
          committed: {
            bank: [],
            inventory: [],
            equipment: [],
            selectedSpell: null,
          },
          recoveryEvidence: { planningSource: "deterministic" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        playerId: "agent-1",
        preparationId,
        reason: "preparation_capability_unavailable",
      });
      expect(commitOwnedDuelPreparationPlan).not.toHaveBeenCalled();
    });

    it("executeUnequip validates slot", async () => {
      const { service } = createActiveService();
      expect(await service.executeUnequip("")).toBe(false);
    });

    it("executeUnequip delegates to the authoritative conserved receipt", async () => {
      const { service, systems, world } = createActiveService();
      const unequipOwnedItem = vi.fn(async () => ({
        ok: true as const,
        playerId: "agent-1",
        itemId: "shortbow",
        slot: "weapon",
        changed: true,
      }));
      systems.set("equipment", { unequipOwnedItem });

      const result = await service.executeUnequip("weapon");
      expect(result).toBe(true);
      expect(unequipOwnedItem).toHaveBeenCalledWith("agent-1", "weapon");
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("executeUnequip propagates authoritative rejection", async () => {
      const { service, systems } = createActiveService();
      systems.set("equipment", {
        unequipOwnedItem: vi.fn(async () => ({
          ok: false as const,
          playerId: "agent-1",
          itemId: "shortbow",
          slot: "weapon",
          changed: false,
          reason: "unequip_rejected" as const,
        })),
      });

      await expect(service.executeUnequip("weapon")).resolves.toBe(false);
    });

    it("executeSetAutoRetaliate sets entity data", async () => {
      const { service, entities } = createActiveService();
      const result = await service.executeSetAutoRetaliate(false);
      expect(result).toBe(true);
      expect(entities.get("agent-1").data.autoRetaliate).toBe(false);
    });
  });

  describe("prayer", () => {
    it("executePrayerDeactivateAll calls system", async () => {
      const { service, systems } = createActiveService();
      const mockDeactivateAll = vi.fn(
        async (playerId: string, operationId: string) => ({
          success: true,
          committed: true,
          playerId,
          operationId,
          replayed: false,
          pointUnits: 2_000_000,
          points: 2,
          maxPoints: 5,
          activePrayers: [],
        }),
      );
      systems.set("prayer", { deactivateAllPrayers: mockDeactivateAll });

      const result = await service.executePrayerDeactivateAll();
      expect(result).toMatchObject({ success: true, activePrayers: [] });
      expect(mockDeactivateAll).toHaveBeenCalledWith(
        "agent-1",
        expect.stringMatching(/^agent-prayer-deactivate-all:/),
      );
    });

    it("executePrayerDeactivateAll returns false when system missing", async () => {
      const { service } = createActiveService();
      const result = await service.executePrayerDeactivateAll();
      expect(result).toMatchObject({
        success: false,
        reason: "atomic_persistence_unavailable",
      });
    });
  });

  describe("trading", () => {
    it("executeTradeRequest validates target", async () => {
      const { service } = createActiveService();
      expect(await service.executeTradeRequest("")).toBe(false);
    });

    it("executeTradeRequest emits event", async () => {
      const { service, world } = createActiveService();
      const result = await service.executeTradeRequest("player-1");
      expect(result).toBe(true);
      expect(world.emit).toHaveBeenCalled();
    });
  });

  describe("utility", () => {
    it("executeFollow moves to target entity", async () => {
      const { service, entities, systems } = createActiveService();
      const requestServerMove = vi.fn(() => true);
      systems.set("network", { requestServerMove });
      entities.set("target-1", {
        data: {
          position: [100, 10, 100],
        },
        position: { x: 100, y: 10, z: 100 },
      });

      const result = await service.executeFollow("target-1");
      expect(result).toBe(true);
      expect(requestServerMove).toHaveBeenCalledWith(
        "agent-1",
        [100, 10, 100],
        {
          runMode: true,
          interactionArrival: undefined,
        },
      );
    });

    it("executeFollow propagates authoritative movement rejection", async () => {
      const { service, entities, systems } = createActiveService();
      systems.set("network", { requestServerMove: vi.fn(() => false) });
      entities.set("target-1", {
        data: { position: [100, 10, 100] },
        position: { x: 100, y: 10, z: 100 },
      });

      await expect(service.executeFollow("target-1")).resolves.toBe(false);
    });

    it("executeFollow returns false for nonexistent target", async () => {
      const { service } = createActiveService();
      const result = await service.executeFollow("nonexistent");
      expect(result).toBe(false);
    });

    it("executeRespawn awaits exact player-death authority completion", async () => {
      const { service, systems, world } = createActiveService();
      const requestPlayerRespawn = vi.fn(async () => true);
      systems.set("player-death", { requestPlayerRespawn });

      await expect(service.executeRespawn()).resolves.toBe(true);
      expect(requestPlayerRespawn).toHaveBeenCalledOnce();
      expect(requestPlayerRespawn).toHaveBeenCalledWith("agent-1");
      expect(world.emit).not.toHaveBeenCalledWith(
        EventType.PLAYER_RESPAWN_REQUEST,
        expect.anything(),
      );
    });

    it("executeRespawn propagates authoritative rejection", async () => {
      const { service, systems } = createActiveService();
      systems.set("player-death", {
        requestPlayerRespawn: vi.fn(async () => false),
      });

      await expect(service.executeRespawn()).resolves.toBe(false);
    });

    it("executeRespawn fails closed without respawn authority", async () => {
      const { service, world } = createActiveService();

      await expect(service.executeRespawn()).resolves.toBe(false);
      expect(world.emit).not.toHaveBeenCalledWith(
        EventType.PLAYER_RESPAWN_REQUEST,
        expect.anything(),
      );
    });
  });

  describe("inactive service", () => {
    it("all methods return false when not active", async () => {
      const { world } = createMockWorld();
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );

      expect(await service.executeBankOpen("bank-1")).toMatchObject({
        success: false,
        failureReason: "player_unavailable",
      });
      expect(await service.executeStoreBuy("s", "i", 1)).toBe(false);
      expect(await service.executeCook("fish")).toBe(false);
      expect(await service.executeNpcInteract("npc")).toBe(false);
      expect(await service.executeUnequip("weapon")).toBe(false);
      expect(await service.executePrayerDeactivateAll()).toMatchObject({
        success: false,
        reason: "player_not_initialized",
      });
      expect(await service.executeTradeRequest("p")).toBe(false);
    });
  });
});
