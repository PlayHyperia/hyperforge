import { describe, expect, it, vi } from "vitest";

vi.mock("../../../eliza", () => ({ getAgentManager: () => null }));
vi.mock("../../../eliza/ModelAgentSpawner.js", () => ({
  getAgentRuntimeByCharacterId: () => null,
}));

import { handleEnterWorld } from "../character-selection.js";

function createFixture() {
  const runeRecovery = vi.fn(async () => []);
  const ammunitionRecovery = vi.fn(async () => []);
  const database = {
    recoverPendingProjectileRuneCostOperationsAsync: runeRecovery,
    recoverPendingAmmunitionShotOperationsAsync: ammunitionRecovery,
  };
  const socket = {
    id: "projectile-custody-socket",
    isLoadTestBot: true,
    ws: { readyState: 1 },
  };
  const addedEntity = {
    id: socket.id,
    data: { id: socket.id, isLoading: true },
    serialize: vi.fn(() => ({ id: socket.id })),
  };
  const entities = {
    add: vi.fn(() => addedEntity),
    get: vi.fn(() => addedEntity),
    remove: vi.fn(),
    items: { entries: () => new Map().entries() },
  };
  const network = { sockets: new Map([[socket.id, socket]]) };
  const world = {
    entities,
    settings: { avatar: { url: "test.vrm" } },
    getSystem: vi.fn((name: string) => {
      if (name === "network") return network;
      if (name === "database") return database;
      return null;
    }),
    emit: vi.fn(),
  };
  return {
    socket,
    world,
    entities,
    runeRecovery,
    ammunitionRecovery,
    send: vi.fn(),
    sendTo: vi.fn(),
  };
}

describe("character selection projectile custody", () => {
  it("rejects a rune reconciliation failure before spawning or publishing a player", async () => {
    const fixture = createFixture();
    fixture.runeRecovery.mockRejectedValueOnce(
      new Error("projectile_rune_cost_fired_reconciliation_required"),
    );

    await expect(
      handleEnterWorld(
        fixture.socket as never,
        { loadTestBot: true },
        fixture.world as never,
        { position: [0, 10, 0], quaternion: [0, 0, 0, 1] } as never,
        fixture.send,
        fixture.sendTo,
      ),
    ).rejects.toThrow("projectile_rune_cost_fired_reconciliation_required");

    expect(fixture.runeRecovery).toHaveBeenCalledWith(fixture.socket.id);
    expect(fixture.ammunitionRecovery).not.toHaveBeenCalled();
    expect(fixture.entities.add).not.toHaveBeenCalled();
    expect(fixture.world.emit).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.sendTo).not.toHaveBeenCalled();
  });

  it("rejects an ammunition reconciliation failure after rune recovery but before spawn", async () => {
    const fixture = createFixture();
    fixture.ammunitionRecovery.mockRejectedValueOnce(
      new Error("ammunition_shot_fired_reconciliation_required"),
    );

    await expect(
      handleEnterWorld(
        fixture.socket as never,
        { loadTestBot: true },
        fixture.world as never,
        { position: [0, 10, 0], quaternion: [0, 0, 0, 1] } as never,
        fixture.send,
        fixture.sendTo,
      ),
    ).rejects.toThrow("ammunition_shot_fired_reconciliation_required");

    expect(fixture.runeRecovery).toHaveBeenCalledWith(fixture.socket.id);
    expect(fixture.ammunitionRecovery).toHaveBeenCalledWith(fixture.socket.id);
    expect(fixture.runeRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.ammunitionRecovery.mock.invocationCallOrder[0]!,
    );
    expect(fixture.entities.add).not.toHaveBeenCalled();
    expect(fixture.world.emit).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.sendTo).not.toHaveBeenCalled();
  });
});
