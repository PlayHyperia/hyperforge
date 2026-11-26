import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionHandler } from "../connection-handler.js";

type ExpiryHarness = {
  armAgentCredentialExpiry: (
    socket: Record<string, unknown>,
    expiresAt: string | undefined,
  ) => void;
};

describe("agent credential socket expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates the exact bound socket when its database session expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const socket = {
      agentCredentialSessionId: "00000000-0000-4000-8000-000000000001",
      disconnect: vi.fn(),
      send: vi.fn(),
    };
    const harness = Object.create(ConnectionHandler.prototype) as ExpiryHarness;
    harness.armAgentCredentialExpiry(socket, "2026-08-27T12:00:01.000Z");
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.send).toHaveBeenCalledWith(
      "kick",
      "agent_credentials_expired",
    );
    expect(socket.disconnect).toHaveBeenCalledWith("agent_credentials_expired");
  });

  it("fails closed immediately for a malformed or already-expired authority timestamp", () => {
    const socket = {
      agentCredentialSessionId: "00000000-0000-4000-8000-000000000001",
      disconnect: vi.fn(),
      send: vi.fn(),
    };
    const harness = Object.create(ConnectionHandler.prototype) as ExpiryHarness;
    harness.armAgentCredentialExpiry(socket, "not-a-time");
    expect(socket.disconnect).toHaveBeenCalledWith("agent_credentials_expired");
  });

  it("does not arm a human socket without an agent session binding", () => {
    vi.useFakeTimers();
    const socket = { disconnect: vi.fn(), send: vi.fn() };
    const harness = Object.create(ConnectionHandler.prototype) as ExpiryHarness;
    harness.armAgentCredentialExpiry(
      socket,
      new Date(Date.now() + 1_000).toISOString(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
