import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  bankDepositAction,
  bankDepositAllAction,
  bankWithdrawAction,
  buildExternalBankRetentionManifest,
} from "../actions/banking";

function createMockRuntime(overrides?: Record<string, unknown>) {
  let player = {
    id: "agent-bank",
    position: [100, 0, 100] as [number, number, number],
    health: { current: 10, max: 10 },
    items: [
      { id: "logs", itemId: "logs", name: "Logs", quantity: 4 },
      {
        id: "tinderbox",
        itemId: "tinderbox",
        name: "Tinderbox",
        quantity: 1,
      },
    ],
    inCombat: false,
  };
  const service = {
    isConnected: vi.fn().mockReturnValue(true),
    getPlayerEntity: vi.fn(() => player),
    getGameState: vi.fn(() => ({ quests: [] })),
    setPlayer: (next: typeof player) => {
      player = next;
    },
    getNearbyEntities: vi.fn().mockReturnValue([
      {
        id: "bank-live",
        name: "Bank",
        type: "bank",
        entityType: "bank",
        position: [102, 0, 102] as [number, number, number],
      },
    ]),
    executeMove: vi.fn().mockResolvedValue(undefined),
    openBank: vi.fn().mockResolvedValue(true),
    closeBank: vi.fn().mockResolvedValue(undefined),
    bankDeposit: vi.fn().mockResolvedValue(true),
    bankDepositAll: vi.fn().mockResolvedValue(true),
    bankWithdraw: vi.fn().mockResolvedValue(true),
    getBankItems: vi.fn().mockReturnValue([]),
    ...overrides,
  };

  return {
    getService: vi.fn().mockReturnValue(service),
    service,
    getPlayer: () => player,
  };
}

describe("banking actions", () => {
  it("derives exact combat, quest, food, unknown-item, and best-tool retention from manifests", () => {
    const runtime = createMockRuntime({
      getGameState: vi.fn(() => ({
        quests: [
          {
            status: "in_progress",
            stageTarget: "logs",
            stageCount: 2,
          },
        ],
      })),
    });
    const items = [
      { id: "bronze_hatchet", name: "Bronze Hatchet", quantity: 1 },
      { id: "iron_hatchet", name: "Iron Hatchet", quantity: 1 },
      { id: "small_fishing_net", name: "Small Fishing Net", quantity: 1 },
      { id: "harpoon", name: "Harpoon", quantity: 1 },
      { id: "bronze_shortsword", name: "Bronze Shortsword", quantity: 1 },
      { id: "bronze_arrow", name: "Bronze Arrow", quantity: 25 },
      { id: "air_rune", name: "Air rune", quantity: 30 },
      { id: "shrimp", name: "Shrimp", quantity: 6 },
      { id: "logs", name: "Logs", quantity: 5 },
      { id: "future_manifest_item", name: "Future Item", quantity: 3 },
    ];

    expect(
      buildExternalBankRetentionManifest(
        runtime.service as never,
        items as never,
      ),
    ).toEqual([
      { itemId: "air_rune", quantity: 30 },
      { itemId: "bronze_arrow", quantity: 25 },
      { itemId: "bronze_shortsword", quantity: 1 },
      { itemId: "future_manifest_item", quantity: 3 },
      { itemId: "harpoon", quantity: 1 },
      { itemId: "iron_hatchet", quantity: 1 },
      { itemId: "logs", quantity: 2 },
      { itemId: "shrimp", quantity: 4 },
      { itemId: "small_fishing_net", quantity: 1 },
    ]);
  });

  it("uses the canonical item ID and treats 'all logs' as item-specific", async () => {
    const runtime = createMockRuntime();

    const result = await bankDepositAction.handler(
      runtime as never,
      { content: { text: "deposit all logs" } } as never,
    );

    expect(result).toMatchObject({ success: true });
    expect(runtime.service.openBank).toHaveBeenCalledWith("bank-live");
    expect(runtime.service.bankDeposit).toHaveBeenCalledWith("logs", 4);
    expect(runtime.service.bankDepositAll).not.toHaveBeenCalled();
    expect(runtime.service.closeBank).toHaveBeenCalledOnce();
  });

  it("rejects a display-name lookalike before opening storage", async () => {
    const runtime = createMockRuntime({
      getNearbyEntities: vi.fn().mockReturnValue([
        {
          id: "bank-sign",
          name: "Bank",
          type: "decoration",
          entityType: "object",
          position: [101, 0, 100],
        },
      ]),
    });

    const result = await bankDepositAction.handler(
      runtime as never,
      { content: { text: "deposit logs" } } as never,
    );

    expect(result).toMatchObject({ success: false });
    expect(runtime.service.openBank).not.toHaveBeenCalled();
  });

  it("observes diagonal arrival inside two tiles before opening", async () => {
    const runtime = createMockRuntime({
      getNearbyEntities: vi.fn().mockReturnValue([
        {
          id: "bank-live",
          name: "Bank",
          type: "bank",
          entityType: "bank",
          position: [104, 0, 104],
        },
      ]),
    });
    runtime.service.executeMove.mockImplementation(async () => {
      runtime.service.setPlayer({
        ...runtime.getPlayer(),
        position: [102, 0, 102],
      });
    });

    const result = await bankDepositAction.handler(
      runtime as never,
      { content: { text: "deposit logs" } } as never,
    );

    expect(result).toMatchObject({ success: true });
    expect(runtime.service.executeMove).toHaveBeenCalledWith({
      target: [104, 0, 104],
      runMode: true,
    });
    expect(runtime.service.openBank).toHaveBeenCalledAfter(
      runtime.service.executeMove,
    );
  });

  it("does not open the bank if transport drops before observed arrival", async () => {
    let connected = true;
    const runtime = createMockRuntime({
      isConnected: vi.fn(() => connected),
      getNearbyEntities: vi.fn().mockReturnValue([
        {
          id: "bank-live",
          name: "Bank",
          type: "bank",
          entityType: "bank",
          position: [104, 0, 104],
        },
      ]),
      executeMove: vi.fn().mockImplementation(async () => {
        connected = false;
      }),
    });

    const result = await bankDepositAction.handler(
      runtime as never,
      { content: { text: "deposit logs" } } as never,
    );

    expect(result).toMatchObject({ success: false });
    expect(runtime.service.openBank).not.toHaveBeenCalled();
  });

  it("resolves withdrawal text to a canonical stored item and reports actual quantity", async () => {
    const runtime = createMockRuntime({
      getBankItems: vi.fn().mockReturnValue([
        {
          itemId: "shrimp",
          name: "Cooked Shrimp",
          quantity: 5,
          slot: 0,
          tabIndex: 0,
        },
      ]),
    });
    runtime.service.setPlayer({
      ...runtime.getPlayer(),
      items: [],
    });
    runtime.service.bankWithdraw.mockImplementation(
      async (itemId: string, quantity: number) => {
        runtime.service.setPlayer({
          ...runtime.getPlayer(),
          items: [
            {
              id: itemId,
              itemId,
              name: "Cooked Shrimp",
              quantity,
            },
          ],
        });
        return true;
      },
    );

    const result = await bankWithdrawAction.handler(
      runtime as never,
      { content: { text: "withdraw 8 cooked shrimp from the bank" } } as never,
    );

    expect(result).toMatchObject({
      success: true,
      text: "Withdrew 5x Cooked Shrimp from the bank.",
    });
    expect(runtime.service.bankWithdraw).toHaveBeenCalledWith("shrimp", 5);
  });

  it("groups identical bankable items and preserves essential tools", async () => {
    const runtime = createMockRuntime();
    runtime.service.setPlayer({
      ...runtime.getPlayer(),
      items: [
        { id: "logs-1", itemId: "logs", name: "Logs", quantity: 2 },
        { id: "logs-2", itemId: "logs", name: "Logs", quantity: 3 },
        {
          id: "tinderbox",
          itemId: "tinderbox",
          name: "Tinderbox",
          quantity: 1,
        },
      ],
    });

    const result = await bankDepositAllAction.handler(
      runtime as never,
      { content: { text: "bank everything" } } as never,
    );

    expect(result).toMatchObject({
      success: true,
      data: { deposited: 5, keptEssentials: 1 },
    });
    expect(runtime.service.bankDeposit).not.toHaveBeenCalled();
    expect(runtime.service.bankDepositAll).toHaveBeenCalledWith([
      { itemId: "tinderbox", quantity: 1 },
    ]);
  });

  it("never reports an uncommitted atomic bulk transfer as success", async () => {
    const bankDepositAll = vi.fn().mockResolvedValue(false);
    const runtime = createMockRuntime({ bankDepositAll });
    runtime.service.setPlayer({
      ...runtime.getPlayer(),
      items: [
        { id: "logs", itemId: "logs", name: "Logs", quantity: 2 },
        { id: "shrimp", itemId: "shrimp", name: "Shrimp", quantity: 2 },
      ],
    });

    const result = await bankDepositAllAction.handler(
      runtime as never,
      { content: { text: "bank everything" } } as never,
    );

    expect(result).toMatchObject({ success: false });
    expect(bankDepositAll).toHaveBeenCalledOnce();
    expect(runtime.service.bankDeposit).not.toHaveBeenCalled();
    expect(runtime.service.closeBank).toHaveBeenCalledOnce();
  });
});
