import { afterEach, describe, expect, it, vi } from "vitest";
import { Packr } from "msgpackr";

import { HyperiaService } from "../services/HyperiaService";
import type { EventType, GroundItemDropResult } from "../types";

vi.mock("../systems/liveKit.js", () => ({
  AgentLiveKit: class {
    async stop(): Promise<void> {}
  },
}));

const PLAYER_ID = "drop-receipt-agent";
const OPERATION_ID = "ground-item-drop:11111111-1111-4111-8111-111111111111";

function successReceipt(
  overrides: Partial<Extract<GroundItemDropResult, { success: true }>> = {},
): GroundItemDropResult {
  return {
    success: true,
    committed: true,
    playerId: PLAYER_ID,
    operationId: OPERATION_ID,
    itemId: "air_rune",
    quantity: 2,
    sourceId: "ground_item_22222222-2222-4222-8222-222222222222",
    position: { x: 4.5, y: 0.1, z: 8.5 },
    replayed: false,
    liveInventoryApplied: true,
    liveCoinsApplied: true,
    presentationReady: true,
    ...overrides,
  };
}

function createService() {
  const service = new HyperiaService({
    agentId: PLAYER_ID,
    getSetting: vi.fn().mockReturnValue(null),
  } as never);
  const sendCommand = vi.fn();
  const internals = service as unknown as {
    characterId: string;
    connectionState: { connected: boolean };
    gameState: { playerEntity: { id: string } | null };
    ws: object | null;
    sendCommand: (command: string, data: unknown) => void;
    broadcastEvent: (eventType: EventType, data: unknown) => void;
    handleMessage: (data: Buffer) => void;
    cancelPendingGroundItemDrops: (reason: string) => void;
  };
  internals.characterId = PLAYER_ID;
  internals.connectionState.connected = true;
  internals.gameState.playerEntity = { id: PLAYER_ID };
  internals.ws = {};
  internals.sendCommand = sendCommand;
  return { service, internals, sendCommand };
}

describe("HyperiaService authoritative ground-item drop receipts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the exact player-scoped receipt delivered through packet dispatch", async () => {
    const { service, internals, sendCommand } = createService();
    let settled = false;
    const pending = service
      .executeDropItem("air_rune", 2, 3, OPERATION_ID)
      .finally(() => {
        settled = true;
      });

    expect(sendCommand).toHaveBeenCalledWith("dropItem", {
      itemId: "air_rune",
      quantity: 2,
      slot: 3,
      operationId: OPERATION_ID,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const packr = new Packr();
    internals.handleMessage(
      Buffer.from(
        packr.pack([
          293,
          {
            ...successReceipt(),
            operationId:
              "ground-item-drop:99999999-9999-4999-8999-999999999999",
          },
        ]),
      ),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    const receipt = successReceipt();
    internals.handleMessage(Buffer.from(packr.pack([293, receipt])));
    await expect(pending).resolves.toEqual(receipt);
  });

  it("retransmits one immutable request and times out as ambiguous", async () => {
    vi.useFakeTimers();
    const { service, sendCommand } = createService();
    const pending = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendCommand).toHaveBeenCalledTimes(3);
    const payloads = sendCommand.mock.calls.map(([, payload]) => payload);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[2]).toEqual(payloads[0]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({
      success: false,
      committed: "unknown",
      operationId: OPERATION_ID,
      reason: "receipt_timeout",
    });
  });

  it("bounds receipt waiting even if transport disconnects after first send", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    const pending = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);
    internals.connectionState.connected = false;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toMatchObject({
      success: false,
      committed: "unknown",
      reason: "receipt_timeout",
    });
  });

  it("joins concurrent exact retries without submitting a second intent", async () => {
    const { service, internals, sendCommand } = createService();
    const first = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);
    const second = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    internals.broadcastEvent("ITEM_DROP_RESULT", successReceipt());
    await expect(first).resolves.toEqual(successReceipt());
    await expect(second).resolves.toEqual(successReceipt());
  });

  it("fails a colliding in-flight payload closed without another send", async () => {
    const { service, internals, sendCommand } = createService();
    const first = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);

    await expect(
      service.executeDropItem("mind_rune", 1, 4, OPERATION_ID),
    ).resolves.toMatchObject({
      success: false,
      committed: "unknown",
      reason: "operation_collision",
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);

    internals.broadcastEvent("ITEM_DROP_RESULT", successReceipt());
    await expect(first).resolves.toEqual(successReceipt());
  });

  it("rejects a malformed supplied operation instead of replacing it", async () => {
    const { service, sendCommand } = createService();

    await expect(
      service.executeDropItem("air_rune", 2, 3, ""),
    ).resolves.toMatchObject({
      success: false,
      committed: false,
      operationId: "",
      reason: "invalid_request",
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rejects a malformed matching receipt as ambiguous authority", async () => {
    const { service, internals } = createService();
    const pending = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);

    internals.broadcastEvent("ITEM_DROP_RESULT", {
      ...successReceipt(),
      position: { x: Number.NaN, y: 0, z: 8.5 },
    });
    await expect(pending).resolves.toMatchObject({
      success: false,
      committed: "unknown",
      reason: "invalid_receipt",
    });
  });

  it("returns an exact authoritative rejection without claiming success", async () => {
    const { service, internals } = createService();
    const pending = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);
    const rejection: GroundItemDropResult = {
      success: false,
      committed: false,
      playerId: PLAYER_ID,
      operationId: OPERATION_ID,
      itemId: "air_rune",
      quantity: 2,
      reason: "insufficient_items",
    };

    internals.broadcastEvent("ITEM_DROP_RESULT", rejection);
    await expect(pending).resolves.toEqual(rejection);
  });

  it("cancels a pending waiter as ambiguous when the service cannot recover", async () => {
    const { service, internals } = createService();
    const pending = service.executeDropItem("air_rune", 2, 3, OPERATION_ID);

    internals.cancelPendingGroundItemDrops("service_stopped");
    await expect(pending).resolves.toMatchObject({
      success: false,
      committed: "unknown",
      reason: "service_stopped",
    });
  });
});
