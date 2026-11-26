import { beforeEach, describe, expect, it, vi } from "vitest";

const { openAuthoritativeAgentBankMock } = vi.hoisted(() => ({
  openAuthoritativeAgentBankMock: vi.fn(),
}));

vi.mock("../AuthoritativeAgentBanking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AuthoritativeAgentBanking.js")>()),
  openAuthoritativeAgentBank: openAuthoritativeAgentBankMock,
}));

import type { AgentBankActionReceipt } from "../AuthoritativeAgentBanking.js";
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successfulOpenReceipt(preparationId: string): AgentBankActionReceipt {
  return {
    success: true,
    operationId: `open-${preparationId}`,
    commitState: "not_applicable",
    replayed: false,
    action: "open",
    playerId: "agent-bank-session",
    bankId: `duel-preparation:${preparationId}`,
    itemId: null,
    requestedQuantity: 0,
    committedQuantity: 0,
    inventoryQuantityAfter: null,
    bankQuantityAfter: null,
    bankItems: [],
  };
}

function failedOpenReceipt(preparationId: string): AgentBankActionReceipt {
  return {
    ...successfulOpenReceipt(preparationId),
    success: false,
    failureReason: "preparation_not_active",
  };
}

function createService() {
  const entities = new Map<string, unknown>();
  entities.set("agent-bank-session", {
    id: "agent-bank-session",
    position: { x: 0, y: 0, z: 0 },
    data: { type: "player", position: [0, 0, 0] },
  });
  const world = {
    entities: {
      get: (id: string) => entities.get(id),
      values: () => entities.values(),
      remove: (id: string) => entities.delete(id),
      items: entities,
      [Symbol.iterator]: () => entities.entries(),
    },
    getSystem: vi.fn((_name: string): unknown => null),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isServer: true,
    network: null,
  };
  const service = new EmbeddedHyperiaService(
    world as never,
    "agent-bank-session",
    "account-bank-session",
    "Bank Session Agent",
  );
  (
    service as unknown as {
      playerEntityId: string;
      isActive: boolean;
    }
  ).playerEntityId = "agent-bank-session";
  (service as unknown as { isActive: boolean }).isActive = true;
  return { service, world };
}

function activePreparationId(service: EmbeddedHyperiaService): string | null {
  return (
    service as unknown as {
      activeBankPreparationId: string | null;
    }
  ).activeBankPreparationId;
}

describe("EmbeddedHyperiaService duel preparation bank session fencing", () => {
  beforeEach(() => {
    openAuthoritativeAgentBankMock.mockReset();
  });

  it("does not resurrect a private bank capability when open returns after revocation", async () => {
    const { service, world } = createService();
    const pendingReceipt = deferred<AgentBankActionReceipt>();
    openAuthoritativeAgentBankMock.mockReturnValueOnce(pendingReceipt.promise);

    const opening = service.executeDuelPreparationBankOpen("preparation-old");
    service.revokeDuelPreparationBankAccess("preparation-old");
    pendingReceipt.resolve(successfulOpenReceipt("preparation-old"));

    await expect(opening).resolves.toMatchObject({ success: true });
    expect(activePreparationId(service)).toBeNull();
    expect(world.emit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparationId: "preparation-old" }),
    );
  });

  it("does not let an older open receipt overwrite the next preparation session", async () => {
    const { service, world } = createService();
    const oldReceipt = deferred<AgentBankActionReceipt>();
    const currentReceipt = deferred<AgentBankActionReceipt>();
    openAuthoritativeAgentBankMock
      .mockReturnValueOnce(oldReceipt.promise)
      .mockReturnValueOnce(currentReceipt.promise);

    const oldOpening =
      service.executeDuelPreparationBankOpen("preparation-old");
    const currentOpening = service.executeDuelPreparationBankOpen(
      "preparation-current",
    );
    currentReceipt.resolve(successfulOpenReceipt("preparation-current"));
    await currentOpening;
    oldReceipt.resolve(successfulOpenReceipt("preparation-old"));
    await oldOpening;

    expect(activePreparationId(service)).toBe("preparation-current");
    const preparationOpenEvents = world.emit.mock.calls.filter(
      ([, payload]) =>
        (payload as { preparationId?: string } | undefined)?.preparationId,
    );
    expect(preparationOpenEvents).toHaveLength(1);
    expect(preparationOpenEvents[0]?.[1]).toMatchObject({
      preparationId: "preparation-current",
    });
  });

  it("keeps a failed newer open from allowing an older success to resurrect", async () => {
    const { service, world } = createService();
    const oldReceipt = deferred<AgentBankActionReceipt>();
    const currentReceipt = deferred<AgentBankActionReceipt>();
    openAuthoritativeAgentBankMock
      .mockReturnValueOnce(oldReceipt.promise)
      .mockReturnValueOnce(currentReceipt.promise);

    const oldOpening =
      service.executeDuelPreparationBankOpen("preparation-old");
    const currentOpening = service.executeDuelPreparationBankOpen(
      "preparation-current",
    );
    currentReceipt.resolve(failedOpenReceipt("preparation-current"));
    await currentOpening;
    oldReceipt.resolve(successfulOpenReceipt("preparation-old"));
    await oldOpening;

    expect(activePreparationId(service)).toBeNull();
    expect(world.emit).not.toHaveBeenCalled();
  });

  it("does not let an older ordinary-bank receipt overwrite a private preparation", async () => {
    const { service, world } = createService();
    const ordinaryReceipt = deferred<AgentBankActionReceipt>();
    const preparationReceipt = deferred<AgentBankActionReceipt>();
    openAuthoritativeAgentBankMock
      .mockReturnValueOnce(ordinaryReceipt.promise)
      .mockReturnValueOnce(preparationReceipt.promise);

    const ordinaryOpening = service.executeBankOpen("ordinary-bank");
    const preparationOpening = service.executeDuelPreparationBankOpen(
      "preparation-current",
    );
    preparationReceipt.resolve(successfulOpenReceipt("preparation-current"));
    await preparationOpening;
    ordinaryReceipt.resolve({
      ...successfulOpenReceipt("ordinary"),
      bankId: "ordinary-bank",
    });
    await ordinaryOpening;

    expect(activePreparationId(service)).toBe("preparation-current");
    expect(world.emit).toHaveBeenCalledTimes(1);
    expect(world.emit.mock.calls[0]?.[1]).toMatchObject({
      preparationId: "preparation-current",
    });
  });

  it("invalidates a pending preparation open when the service stops", async () => {
    const { service, world } = createService();
    const pendingReceipt = deferred<AgentBankActionReceipt>();
    openAuthoritativeAgentBankMock.mockReturnValueOnce(pendingReceipt.promise);

    const opening = service.executeDuelPreparationBankOpen("preparation-stop");
    await service.stop();
    pendingReceipt.resolve(successfulOpenReceipt("preparation-stop"));
    await opening;

    expect(activePreparationId(service)).toBeNull();
    expect(world.emit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparationId: "preparation-stop" }),
    );
  });

  it("ignores a stale terminal revocation after the next preparation is active", async () => {
    const { service } = createService();
    openAuthoritativeAgentBankMock
      .mockResolvedValueOnce(successfulOpenReceipt("preparation-old"))
      .mockResolvedValueOnce(successfulOpenReceipt("preparation-current"));

    await service.executeDuelPreparationBankOpen("preparation-old");
    await service.executeDuelPreparationBankOpen("preparation-current");
    service.revokeDuelPreparationBankAccess("preparation-old");

    expect(activePreparationId(service)).toBe("preparation-current");
  });

  it("clears a failed request token so later revocation cannot cancel the next open", async () => {
    const { service } = createService();
    openAuthoritativeAgentBankMock
      .mockRejectedValueOnce(new Error("bank transport failed"))
      .mockResolvedValueOnce(successfulOpenReceipt("preparation-current"));

    await expect(
      service.executeDuelPreparationBankOpen("preparation-old"),
    ).rejects.toThrow("bank transport failed");
    await service.executeDuelPreparationBankOpen("preparation-current");
    service.revokeDuelPreparationBankAccess("preparation-old");

    expect(activePreparationId(service)).toBe("preparation-current");
  });

  it("allows an active private preparation to refresh persisted custody and invalidates every loadout cache", async () => {
    const { service, world } = createService();
    const refresh = vi.fn(async () => true);
    world.getSystem.mockImplementation((name: string) =>
      name === "equipment"
        ? { refreshOwnedDuelPreparationCustodyFromPersistence: refresh }
        : null,
    );
    openAuthoritativeAgentBankMock.mockResolvedValueOnce(
      successfulOpenReceipt("preparation-current"),
    );
    await service.executeDuelPreparationBankOpen("preparation-current");
    Object.assign(service as unknown as Record<string, unknown>, {
      _inventoryCacheTick: 7,
      _equipmentCacheTick: 7,
      _gameStateCacheTick: 7,
    });

    await expect(
      service.executeDuelPreparationCustodyRefresh("preparation-current"),
    ).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledWith("agent-bank-session");
    expect(
      (service as unknown as { _inventoryCacheTick: number })
        ._inventoryCacheTick,
    ).toBe(-1);
    expect(
      (service as unknown as { _equipmentCacheTick: number })
        ._equipmentCacheTick,
    ).toBe(-1);
    expect(
      (service as unknown as { _gameStateCacheTick: number })
        ._gameStateCacheTick,
    ).toBe(-1);

    service.revokeDuelPreparationBankAccess("preparation-current");
    await expect(
      service.executeDuelPreparationCustodyRefresh("preparation-current"),
    ).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
