import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  smeltOreAction,
  smithItemAction,
  fletchItemAction,
  tanHideAction,
  runecraftAction,
} from "../actions/crafting";

function createMockRuntime(overrides?: Record<string, unknown>) {
  const service = {
    isConnected: vi.fn().mockReturnValue(true),
    getPlayerEntity: vi.fn().mockReturnValue({
      position: [100, 10, 100] as [number, number, number],
      items: [
        { itemId: "copper_ore", name: "Copper ore", quantity: 1 },
        { itemId: "tin_ore", name: "Tin ore", quantity: 1 },
      ],
      equipment: {},
    }),
    getNearbyEntities: vi.fn().mockReturnValue([
      {
        id: "furnace-1",
        name: "Furnace",
        type: "furnace",
        entityType: "furnace",
        position: [102, 10, 100] as [number, number, number],
      },
      {
        id: "anvil-1",
        name: "Anvil",
        type: "anvil",
        entityType: "anvil",
        position: [102, 10, 100] as [number, number, number],
      },
    ]),
    executeMove: vi.fn().mockResolvedValue(undefined),
    executeTanning: vi.fn().mockResolvedValue(true),
    executeSmelting: vi.fn().mockResolvedValue(true),
    executeSmithing: vi.fn().mockResolvedValue(true),
    executeRunecrafting: vi.fn().mockResolvedValue(true),
    executeFletching: vi.fn().mockResolvedValue(true),
    interactWithEntity: vi.fn(),
    ...overrides,
  };

  return {
    getService: vi.fn().mockReturnValue(service),
    service,
  };
}

describe("crafting actions", () => {
  describe("smeltOreAction", () => {
    it("validates when connected with ore in inventory", async () => {
      const runtime = createMockRuntime();
      const result = await smeltOreAction.validate(runtime as never);
      expect(result).toBe(true);
    });

    it("fails validation when not connected", async () => {
      const runtime = createMockRuntime({
        isConnected: vi.fn().mockReturnValue(false),
      });
      const result = await smeltOreAction.validate(runtime as never);
      expect(result).toBe(false);
    });

    it("submits the exact typed furnace and bar recipe", async () => {
      const runtime = createMockRuntime();
      const result = await smeltOreAction.handler(
        runtime as never,
        { content: { text: "smelt my ore" } } as never,
      );

      expect(result).toMatchObject({ success: true });
      expect(runtime.service.executeSmelting).toHaveBeenCalledWith(
        "furnace-1",
        "bronze_bar",
        1,
      );
      expect(runtime.service.interactWithEntity).not.toHaveBeenCalled();
    });

    it("observes arrival inside two tiles before submitting", async () => {
      let player = {
        position: [100, 10, 100] as [number, number, number],
        items: [
          { itemId: "copper_ore", name: "Copper ore", quantity: 1 },
          { itemId: "tin_ore", name: "Tin ore", quantity: 1 },
        ],
        equipment: {},
      };
      const executeMove = vi.fn().mockImplementation(async () => {
        player = { ...player, position: [103, 10, 100] };
      });
      const runtime = createMockRuntime({
        getPlayerEntity: vi.fn(() => player),
        getNearbyEntities: vi.fn(() => [
          {
            id: "furnace-remote",
            name: "Furnace",
            type: "furnace",
            entityType: "furnace",
            position: [104, 10, 100],
          },
        ]),
        executeMove,
      });

      const result = await smeltOreAction.handler(
        runtime as never,
        { content: { text: "smelt my ore" } } as never,
      );

      expect(result).toMatchObject({ success: true });
      expect(executeMove).toHaveBeenCalledWith({
        target: [104, 10, 100],
        runMode: true,
      });
      expect(runtime.service.executeSmelting).toHaveBeenCalledWith(
        "furnace-remote",
        "bronze_bar",
        1,
      );
    });

    it("does not submit if transport drops before arrival", async () => {
      let connected = true;
      const runtime = createMockRuntime({
        isConnected: vi.fn(() => connected),
        getNearbyEntities: vi.fn(() => [
          {
            id: "furnace-remote",
            name: "Furnace",
            type: "furnace",
            entityType: "furnace",
            position: [104, 10, 100],
          },
        ]),
        executeMove: vi.fn().mockImplementation(async () => {
          connected = false;
        }),
      });

      const result = await smeltOreAction.handler(
        runtime as never,
        { content: { text: "smelt my ore" } } as never,
      );

      expect(result).toMatchObject({
        success: false,
        error: "Furnace was not reached",
      });
      expect(runtime.service.executeSmelting).not.toHaveBeenCalled();
    });

    it("does not trust a furnace-looking display name", async () => {
      const runtime = createMockRuntime();
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "spoof-furnace",
          name: "Furnace",
          type: "object",
          entityType: "decoration",
          position: [101, 10, 100],
        },
      ]);
      expect(await smeltOreAction.validate(runtime as never)).toBe(false);
    });

    it("does not report success without authoritative completion", async () => {
      const runtime = createMockRuntime({
        executeSmelting: vi.fn().mockResolvedValue(false),
      });
      const result = await smeltOreAction.handler(
        runtime as never,
        { content: { text: "smelt my ore" } } as never,
      );
      expect(result).toMatchObject({ success: false });
    });
  });

  describe("smithItemAction", () => {
    it("validates when connected with bars in inventory", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "bronze_bar", name: "Bronze bar", quantity: 1 }],
        equipment: {},
      });
      const result = await smithItemAction.validate(runtime as never);
      expect(result).toBe(true);
    });

    it("submits the exact typed anvil and a concrete legal recipe", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "bronze_bar", name: "Bronze bar", quantity: 1 }],
        equipment: {},
      });
      const result = await smithItemAction.handler(
        runtime as never,
        { content: { text: "smith an item" } } as never,
      );

      expect(result).toMatchObject({ success: true });
      expect(runtime.service.executeSmithing).toHaveBeenCalledWith(
        "anvil-1",
        "bronze_dagger",
        1,
      );
      expect(runtime.service.interactWithEntity).not.toHaveBeenCalled();
    });

    it("does not trust an anvil-looking display name", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "bronze_bar", name: "Bronze bar", quantity: 1 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "spoof-anvil",
          name: "Anvil",
          type: "object",
          entityType: "decoration",
          position: [101, 10, 100],
        },
      ]);
      expect(await smithItemAction.validate(runtime as never)).toBe(false);
    });

    it("does not report success without authoritative completion", async () => {
      const runtime = createMockRuntime({
        executeSmithing: vi.fn().mockResolvedValue(false),
      });
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "bronze_bar", name: "Bronze bar", quantity: 1 }],
        equipment: {},
      });
      const result = await smithItemAction.handler(
        runtime as never,
        { content: { text: "smith an item" } } as never,
      );
      expect(result).toMatchObject({ success: false });
    });
  });

  describe("fletchItemAction", () => {
    it("fails validation without knife and logs", async () => {
      const runtime = createMockRuntime();
      const result = await fletchItemAction.validate(runtime as never);
      expect(result).toBe(false);
    });

    it("validates with knife and logs in inventory", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [
          { itemId: "knife", name: "Knife", quantity: 1 },
          { itemId: "logs", name: "Logs", quantity: 1 },
        ],
        equipment: { weapon: { item: { itemId: "knife" } } },
      });
      const result = await fletchItemAction.validate(runtime as never);
      expect(result).toBe(true);
    });

    it("submits an exact manifest recipe and waits for completion", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [
          { itemId: "knife", name: "Knife", quantity: 1 },
          { itemId: "oak_logs", name: "Oak logs", quantity: 1 },
        ],
        equipment: { weapon: { item: { itemId: "knife" } } },
      });
      const result = await fletchItemAction.handler(
        runtime as never,
        { content: { text: "make a shortbow" } } as never,
      );
      expect(result).toMatchObject({ success: true });
      expect(runtime.service.executeFletching).toHaveBeenCalledWith(
        "oak_shortbow_u:oak_logs",
        1,
      );
      expect(runtime.service.interactWithEntity).not.toHaveBeenCalled();
    });

    it("does not report success without authoritative completion", async () => {
      const runtime = createMockRuntime({
        executeFletching: vi.fn().mockResolvedValue(false),
      });
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [
          { itemId: "knife", name: "Knife", quantity: 1 },
          { itemId: "logs", name: "Logs", quantity: 1 },
        ],
        equipment: { weapon: { item: { itemId: "knife" } } },
      });
      const result = await fletchItemAction.handler(
        runtime as never,
        { content: { text: "make arrow shafts" } } as never,
      );
      expect(result).toMatchObject({ success: false });
    });
  });

  describe("tanHideAction", () => {
    it("fails validation without hides", async () => {
      const runtime = createMockRuntime();
      const result = await tanHideAction.validate(runtime as never);
      expect(result).toBe(false);
    });

    it("submits an exact typed Tanner and supported hide recipe", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "cowhide", name: "Cowhide", quantity: 2 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "tanner-live",
          name: "Leather worker",
          type: "npc",
          npcType: "tanner",
          position: [102, 10, 100],
        },
      ]);

      expect(await tanHideAction.validate(runtime as never)).toBe(true);
      const result = await tanHideAction.handler(
        runtime as never,
        { content: { text: "tan my hides" } } as never,
      );
      expect(result).toMatchObject({ success: true });
      expect(runtime.service.executeTanning).toHaveBeenCalledWith(
        "tanner-live",
        "cowhide",
        2,
      );
      expect(runtime.service.interactWithEntity).not.toHaveBeenCalled();
    });

    it("does not trust a Tanner-looking display name without typed identity", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "cowhide", name: "Cowhide", quantity: 1 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "spoof",
          name: "Tanner",
          type: "npc",
          npcType: "shopkeeper",
          position: [101, 10, 100],
        },
      ]);

      expect(await tanHideAction.validate(runtime as never)).toBe(false);
    });

    it("does not report success without authoritative completion", async () => {
      const runtime = createMockRuntime({
        executeTanning: vi.fn().mockResolvedValue(false),
      });
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "cowhide", name: "Cowhide", quantity: 2 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "tanner-live",
          type: "npc",
          npcType: "tanner",
          position: [102, 10, 100],
        },
      ]);
      const result = await tanHideAction.handler(
        runtime as never,
        { content: { text: "tan my hides" } } as never,
      );
      expect(result).toMatchObject({ success: false });
    });
  });

  describe("runecraftAction", () => {
    it("fails validation without essence", async () => {
      const runtime = createMockRuntime();
      const result = await runecraftAction.validate(runtime as never);
      expect(result).toBe(false);
    });

    it("submits the exact typed altar and waits for rune completion", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "pure_essence", name: "Pure essence", quantity: 4 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "air-altar",
          name: "Air Altar",
          type: "runecrafting_altar",
          entityType: "runecrafting_altar",
          runeType: "air",
          position: [102, 10, 100],
        },
      ]);

      expect(await runecraftAction.validate(runtime as never)).toBe(true);
      const result = await runecraftAction.handler(
        runtime as never,
        { content: { text: "craft air runes" } } as never,
      );
      expect(result).toMatchObject({ success: true });
      expect(runtime.service.executeRunecrafting).toHaveBeenCalledWith(
        "air-altar",
        "air",
      );
      expect(runtime.service.interactWithEntity).not.toHaveBeenCalled();
    });

    it("rejects display-name altar lookalikes without typed identity", async () => {
      const runtime = createMockRuntime();
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "rune_essence", name: "Rune essence", quantity: 1 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "spoof-altar",
          name: "Air Rune Altar",
          type: "decoration",
          runeType: "air",
          position: [101, 10, 100],
        },
      ]);
      expect(await runecraftAction.validate(runtime as never)).toBe(false);
    });

    it("does not report success without authoritative completion", async () => {
      const runtime = createMockRuntime({
        executeRunecrafting: vi.fn().mockResolvedValue(false),
      });
      runtime.service.getPlayerEntity.mockReturnValue({
        position: [100, 10, 100],
        items: [{ itemId: "rune_essence", name: "Rune essence", quantity: 1 }],
        equipment: {},
      });
      runtime.service.getNearbyEntities.mockReturnValue([
        {
          id: "air-altar",
          name: "Air Altar",
          type: "runecrafting_altar",
          runeType: "air",
          position: [102, 10, 100],
        },
      ]);
      const result = await runecraftAction.handler(
        runtime as never,
        { content: { text: "craft air runes" } } as never,
      );
      expect(result).toMatchObject({ success: false });
    });
  });
});
