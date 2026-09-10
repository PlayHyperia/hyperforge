import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresDuelPreparationStore } from "../../../StreamingDuelScheduler/preparation.js";
import { handleDuelPreparationHostLease } from "../duel/preparation-host-lease.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const preparationId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const executableBuildId = "33".repeat(32);
const playerId = "external-agent-character";

const lease = {
  preparationId,
  agentId: playerId,
  ownerId,
  executableBuildId,
  claimedAt: 1,
  heartbeatAt: 2,
  expiresAt: 17_000,
};

function harness(authenticated = true) {
  const send = vi.fn();
  const emit = vi.fn();
  return {
    send,
    socket: {
      player: authenticated ? { id: playerId } : undefined,
      send,
    } as never,
    world: {
      drizzleDb: {},
      pgPool: {},
      emit,
    } as never,
    emit,
  };
}

describe("external private-preparation host lease packets", () => {
  let claim: ReturnType<typeof vi.spyOn>;
  let heartbeat: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("DUEL_PREPARATION_AGENT_HOST_LEASE_MS", "15000");
    vi.stubEnv("DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS", "3000");
    vi.stubEnv("DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS", "10000");
    vi.stubEnv("NODE_ENV", "test");
    claim = vi
      .spyOn(PostgresDuelPreparationStore.prototype, "claimContestantHostLease")
      .mockResolvedValue(lease);
    heartbeat = vi
      .spyOn(
        PostgresDuelPreparationStore.prototype,
        "heartbeatContestantHostLease",
      )
      .mockResolvedValue(lease);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("binds claim and immediate refresh to authenticated socket identity", async () => {
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    const input = {
      preparationId,
      agentId: playerId,
      ownerId,
      executableBuildId,
      leaseDurationMs: 15_000,
    };
    expect(claim).toHaveBeenCalledWith(input);
    expect(heartbeat).toHaveBeenCalledWith(input);
    expect(state.send).toHaveBeenCalledWith("duelPreparationHostLease", {
      requestId,
      preparationId,
      action: "claim",
      status: "active",
      heartbeatAfterMs: 3_000,
    });
    expect(state.emit).toHaveBeenCalledWith(
      "duel:preparation:external_host_active",
      { preparationId, agentId: playerId, ownerId, executableBuildId },
    );
  });

  it("refreshes an exact live owner without entering claim", async () => {
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "heartbeat",
      },
      state.world,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledWith({
      preparationId,
      agentId: playerId,
      ownerId,
      executableBuildId,
      leaseDurationMs: 15_000,
    });
    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "active", action: "heartbeat" }),
    );
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("rejects a missing authenticated contestant before database authority", async () => {
    const state = harness(false);
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "rejected" }),
    );
  });

  it("reports transient persistence failure without fabricating rejection", async () => {
    const state = harness();
    claim.mockRejectedValueOnce(new Error("database unavailable"));
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "unavailable" }),
    );
  });

  it("ignores malformed correlation IDs", async () => {
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId: "not-a-uuid",
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });

  it("fails closed when production has no approved build allowlist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS", "");
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "unavailable" }),
    );
  });

  it("accepts only the exact build on the production allowlist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS", executableBuildId);
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    expect(claim).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "active" }),
    );
  });

  it("rejects a build outside the exact production allowlist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS", "44".repeat(32));
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId,
        action: "claim",
      },
      state.world,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "rejected" }),
    );
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-build-id"],
    ["uppercase", "AB".repeat(32)],
  ])("rejects a %s executable build identity", async (_label, buildId) => {
    const state = harness();
    await handleDuelPreparationHostLease(
      state.socket,
      {
        requestId,
        preparationId,
        ownerId,
        executableBuildId: buildId,
        action: "claim",
      },
      state.world,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith(
      "duelPreparationHostLease",
      expect.objectContaining({ status: "rejected" }),
    );
  });
});
