import { describe, expect, it, vi } from "vitest";
import { UwsWebSocketAdapter, type UwsUserData } from "../UwsWebSocketAdapter";

function createHarness(statuses: number[]) {
  const userData: UwsUserData = {
    wsId: "socket-1",
    remoteAddress: "127.0.0.1",
    query: {},
    adapter: null,
  };
  const send = vi.fn((_data: unknown) => statuses.shift() ?? 1);
  const end = vi.fn();
  const socket = {
    getUserData: () => userData,
    getBufferedAmount: vi.fn(() => 0),
    send,
    end,
    close: vi.fn(),
    ping: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
  };
  const adapter = new UwsWebSocketAdapter(socket as never);
  userData.adapter = adapter;
  return { adapter, send, end, socket };
}

describe("UwsWebSocketAdapter reliable delivery", () => {
  it("does not duplicate a packet accepted into native backpressure", () => {
    const { adapter, send } = createHarness([0, 1]);

    expect(adapter.sendReliable(new Uint8Array([1]))).toBe(true);
    expect(adapter.getReliableQueueStats()).toEqual({ packets: 0, bytes: 0 });
    adapter.dispatchDrain();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped critical packet on drain before later critical traffic", () => {
    const { adapter, send } = createHarness([2, 1, 1]);

    expect(adapter.sendReliable(new Uint8Array([1]))).toBe(true);
    expect(adapter.sendReliable(new Uint8Array([2]))).toBe(true);
    expect(adapter.getReliableQueueStats()).toEqual({ packets: 2, bytes: 2 });

    adapter.dispatchDrain();

    expect(
      send.mock.calls.map(([payload]) => [...(payload as Uint8Array)]),
    ).toEqual([[1], [1], [2]]);
    expect(adapter.getReliableQueueStats()).toEqual({ packets: 0, bytes: 0 });
  });

  it("stops flushing after a packet is accepted into native backpressure", () => {
    const { adapter, send } = createHarness([2, 0, 1]);

    adapter.sendReliable(new Uint8Array([1]));
    adapter.sendReliable(new Uint8Array([2]));
    adapter.dispatchDrain();

    expect(send).toHaveBeenCalledTimes(2);
    expect(adapter.getReliableQueueStats()).toEqual({ packets: 1, bytes: 1 });
    adapter.dispatchDrain();
    expect(send).toHaveBeenCalledTimes(3);
    expect(adapter.getReliableQueueStats()).toEqual({ packets: 0, bytes: 0 });
  });

  it("reports native and application-retained bytes and clears them on close", () => {
    const { adapter, socket } = createHarness([2]);
    socket.getBufferedAmount.mockReturnValue(7);

    adapter.sendReliable(new Uint8Array([1, 2, 3]));
    expect(adapter.bufferedAmount).toBe(10);
    adapter.dispatchClose(1000);

    expect(adapter.bufferedAmount).toBe(0);
    expect(adapter.getReliableQueueStats()).toEqual({ packets: 0, bytes: 0 });
  });
});
