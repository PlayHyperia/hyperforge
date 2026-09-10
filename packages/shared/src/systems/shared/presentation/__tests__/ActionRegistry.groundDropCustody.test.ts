import { describe, expect, it, vi } from "vitest";

import type { World } from "../../../../types";
import { EventBus } from "../../infrastructure/EventBus";
import { ActionRegistry } from "../ActionRegistry";

const PLAYER_ID = "action-drop-player";
const OPERATION_ID = "ground-item-drop:11111111-1111-4111-8111-111111111111";

function createFixture(
  dropOwnedItemAtomic: (...args: unknown[]) => Promise<Record<string, unknown>>,
) {
  const inventory = { dropOwnedItemAtomic: vi.fn(dropOwnedItemAtomic) };
  const world = {
    $eventBus: new EventBus(),
    isServer: true,
    network: { id: PLAYER_ID },
    getSystem: (name: string) => (name === "inventory" ? inventory : undefined),
  } as unknown as World;
  const registry = new ActionRegistry(world);
  return { world, registry, inventory };
}

describe("ActionRegistry authoritative ground drop", () => {
  it("waits for the exact atomic receipt and preserves a caller retry identity", async () => {
    let release: ((receipt: Record<string, unknown>) => void) | undefined;
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(async () => gate);
    await fixture.registry.init();

    let settled = false;
    const pending = fixture.world
      .actionRegistry!.execute(
        "drop_item",
        { playerId: PLAYER_ID },
        { itemId: "air_rune", quantity: 2, operationId: OPERATION_ID },
      )
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => {
      expect(fixture.inventory.dropOwnedItemAtomic).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    expect(fixture.inventory.dropOwnedItemAtomic).toHaveBeenCalledWith(
      PLAYER_ID,
      OPERATION_ID,
      "air_rune",
      2,
    );

    release?.({ ok: true, committed: true });
    await expect(pending).resolves.toEqual({
      success: true,
      committed: true,
      operationId: OPERATION_ID,
      message: "Dropped item air_rune",
    });
  });

  it("does not rewrite a zero quantity into a one-item destructive action", async () => {
    const fixture = createFixture(async () => ({
      ok: false,
      committed: false,
      reason: "invalid_request",
    }));
    await fixture.registry.init();

    await expect(
      fixture.world.actionRegistry!.execute(
        "drop_item",
        { playerId: PLAYER_ID },
        { itemId: "air_rune", quantity: 0, operationId: OPERATION_ID },
      ),
    ).resolves.toMatchObject({
      success: false,
      committed: false,
      operationId: OPERATION_ID,
    });
    expect(fixture.inventory.dropOwnedItemAtomic).toHaveBeenCalledWith(
      PLAYER_ID,
      OPERATION_ID,
      "air_rune",
      0,
    );
  });
});
