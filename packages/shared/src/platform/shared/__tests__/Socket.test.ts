import { describe, expect, it, vi } from "vitest";

import { Socket } from "../Socket";
import type {
  NetworkWithSocket,
  NodeWebSocket,
} from "../../../types/network/networking";

describe("Socket", () => {
  it("normalizes typed-array packets to an ArrayBuffer before sending", () => {
    const send = vi.fn();
    const ws = {
      on: vi.fn(),
      removeListener: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
      send,
      close: vi.fn(),
    } as unknown as NodeWebSocket;
    const network = {
      enqueue: vi.fn(),
      onDisconnect: vi.fn(),
    } satisfies NetworkWithSocket;
    const socket = new Socket({ id: "test", ws, network });
    const bytes = new Uint8Array([1, 2, 3, 4]);

    socket.sendPacket(bytes);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0];
    expect(payload).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(payload as ArrayBuffer))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(payload).not.toBe(bytes.buffer);
  });
});
