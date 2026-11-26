import { describe, expect, it, vi } from "vitest";

import { forcePlayerDataSave } from "../shutdown.js";

describe("graceful shutdown player persistence", () => {
  it("awaits health/position, inventory, equipment, and coin snapshots", async () => {
    const completed: string[] = [];
    const systems = {
      player: {
        saveAllPlayersToDatabase: vi.fn(async () => {
          await Promise.resolve();
          completed.push("player");
        }),
      },
      inventory: {
        destroyAsync: vi.fn(async () => {
          await Promise.resolve();
          completed.push("inventory");
        }),
      },
      equipment: {
        destroyAsync: vi.fn(async () => {
          await Promise.resolve();
          completed.push("equipment");
        }),
      },
      "coin-pouch": {
        destroyAsync: vi.fn(async () => {
          await Promise.resolve();
          completed.push("coin-pouch");
        }),
      },
    };
    const world = {
      getSystem: vi.fn((name: keyof typeof systems) => systems[name]),
    };

    await forcePlayerDataSave({ world: world as never });

    expect(systems.player.saveAllPlayersToDatabase).toHaveBeenCalledOnce();
    expect(systems.inventory.destroyAsync).toHaveBeenCalledOnce();
    expect(systems.equipment.destroyAsync).toHaveBeenCalledOnce();
    expect(systems["coin-pouch"].destroyAsync).toHaveBeenCalledOnce();
    expect(completed.sort()).toEqual([
      "coin-pouch",
      "equipment",
      "inventory",
      "player",
    ]);
  });
});
