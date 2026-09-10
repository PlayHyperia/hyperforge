import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventType } from "@hyperforge/shared";
import { handleDropItem } from "../../../src/systems/ServerNetwork/handlers/inventory.js";
import { destroyIdempotencyService } from "../../../src/systems/ServerNetwork/services/IdempotencyService.js";
import { destroyAllRateLimiters } from "../../../src/systems/ServerNetwork/services/SlidingWindowRateLimiter.js";

const PLAYER_ID = "drop-operation-player";
const OPERATION_ID = "ground-item-drop:11111111-1111-4111-8111-111111111111";

function createFixture() {
  const emit = vi.fn();
  const socket = {
    player: { id: PLAYER_ID },
  };
  const world = {
    emit,
    getSystem: (name: string) =>
      name === "duel" ? { isPlayerInDuel: () => false } : undefined,
  };
  return { socket, world, emit };
}

describe("drop request operation identity", () => {
  beforeEach(() => {
    destroyIdempotencyService();
    destroyAllRateLimiters();
  });

  afterEach(() => {
    destroyIdempotencyService();
    destroyAllRateLimiters();
    vi.restoreAllMocks();
  });

  it("forwards one validated client identity and the exact requested quantity", () => {
    const fixture = createFixture();

    handleDropItem(
      fixture.socket as never,
      {
        itemId: "air_rune",
        quantity: 2,
        slot: 3,
        operationId: OPERATION_ID,
      },
      fixture.world as never,
    );

    expect(fixture.emit).toHaveBeenCalledWith(EventType.ITEM_DROP, {
      playerId: PLAYER_ID,
      itemId: "air_rune",
      quantity: 2,
      slot: 3,
      operationId: OPERATION_ID,
    });
  });

  it("does not let an invalid request consume the later valid operation", () => {
    const fixture = createFixture();

    handleDropItem(
      fixture.socket as never,
      {
        itemId: "air_rune",
        quantity: "2",
        slot: 3,
        operationId: OPERATION_ID,
      },
      fixture.world as never,
    );
    handleDropItem(
      fixture.socket as never,
      {
        itemId: "air_rune",
        quantity: 2,
        slot: 3,
        operationId: OPERATION_ID,
      },
      fixture.world as never,
    );

    expect(fixture.emit).toHaveBeenCalledOnce();
    expect(fixture.emit).toHaveBeenCalledWith(
      EventType.ITEM_DROP,
      expect.objectContaining({ operationId: OPERATION_ID, quantity: 2 }),
    );
  });

  it("forwards exact retries and collisions to durable operation authority", () => {
    const fixture = createFixture();
    const first = {
      itemId: "air_rune",
      quantity: 2,
      slot: 3,
      operationId: OPERATION_ID,
    };

    handleDropItem(fixture.socket as never, first, fixture.world as never);
    handleDropItem(fixture.socket as never, first, fixture.world as never);
    handleDropItem(
      fixture.socket as never,
      { ...first, quantity: 1 },
      fixture.world as never,
    );

    expect(fixture.emit).toHaveBeenCalledTimes(3);
    expect(fixture.emit.mock.calls[2]?.[1]).toMatchObject({
      operationId: OPERATION_ID,
      quantity: 1,
    });
  });

  it("rejects malformed supplied identities instead of replacing them", () => {
    const fixture = createFixture();

    handleDropItem(
      fixture.socket as never,
      {
        itemId: "air_rune",
        quantity: 2,
        operationId: "ground-item-drop:not-a-uuid",
      },
      fixture.world as never,
    );

    expect(fixture.emit).not.toHaveBeenCalled();
  });

  it("rejects out-of-range quantities and slots instead of changing their meaning", () => {
    const fixture = createFixture();

    handleDropItem(
      fixture.socket as never,
      { itemId: "air_rune", quantity: 0, operationId: OPERATION_ID },
      fixture.world as never,
    );
    handleDropItem(
      fixture.socket as never,
      { itemId: "air_rune", quantity: 1, slot: -1, operationId: OPERATION_ID },
      fixture.world as never,
    );

    expect(fixture.emit).not.toHaveBeenCalled();
  });
});
