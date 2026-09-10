import { beforeAll, describe, expect, it, vi } from "vitest";

import { PlayerMigration } from "../../../../types/core/core";
import type { StreamingDuelStyleObservationContext } from "../../../../types/game/streaming-duel-action-observation";
import { EventBus } from "../../infrastructure/EventBus";
import { PlayerSystem } from "../PlayerSystem";

const styleContext = {
  operationId: "00000000-0000-4000-8000-000000000501",
  tick: 18,
  observedAt: 1_800_000_000_018,
  cycleId: "cycle-style",
  duelId: "duel-style",
  actorId: "agent-style",
  opponentId: "agent-opponent",
  phase: "FIGHTING",
  combatRole: "ranged",
  tacticalMacro: "kite",
  style: "rapid",
} satisfies StreamingDuelStyleObservationContext;

describe("PlayerSystem atomic attack-style authority", () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID) {
      throw new Error("Web Crypto is required for style receipt tests");
    }
  });

  function createFixture(
    commitImplementation?: (...args: any[]) => Promise<any>,
  ) {
    const eventBus = new EventBus();
    const playerEntity = { type: "player", data: {} };
    const equipment = {
      getPlayerEquipment: vi.fn(() => ({
        weapon: { item: { weaponType: "bow" } },
      })),
    };
    const commitAttackStyleOperationAsync = vi.fn(
      commitImplementation ??
        (async (request) => ({
          ...request,
          replayed: false,
          operationCommittedStyle: request.requestedStyle,
          currentStyle: request.requestedStyle,
        })),
    );
    const database = {
      commitAttackStyleOperationAsync,
      savePlayer: vi.fn(),
    };
    const world = {
      isServer: true,
      currentTick: 18,
      $eventBus: eventBus,
      entities: new Map([["agent-style", playerEntity]]),
      getPlayer: vi.fn(() => playerEntity),
      getSystem: vi.fn((name: string) =>
        name === "database"
          ? database
          : name === "equipment"
            ? equipment
            : undefined,
      ),
    };
    const system = new PlayerSystem(world as never);
    const player = PlayerMigration.createNewPlayer(
      "agent-style",
      "agent-style",
      "Style Agent",
    );
    const internals = system as unknown as {
      players: Map<string, typeof player>;
      playerAttackStyles: Map<
        string,
        { playerId: string; selectedStyle: string }
      >;
      databaseSystem: typeof database;
    };
    internals.players.set(player.id, player);
    internals.playerAttackStyles.set(player.id, {
      playerId: player.id,
      selectedStyle: "accurate",
    });
    internals.databaseSystem = database;
    return {
      system,
      internals,
      database,
      equipment,
      commitAttackStyleOperationAsync,
    };
  }

  it("does not claim or apply the style before its atomic receipt commits", async () => {
    let release: ((value: any) => void) | undefined;
    const fixture = createFixture(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = fixture.system.changeAttackStyleAtomic(
      "agent-style",
      "rapid",
      styleContext,
    );
    await vi.waitFor(() =>
      expect(fixture.commitAttackStyleOperationAsync).toHaveBeenCalledOnce(),
    );
    expect(
      fixture.internals.playerAttackStyles.get("agent-style")?.selectedStyle,
    ).toBe("accurate");

    const request = fixture.commitAttackStyleOperationAsync.mock.calls[0]![0];
    release?.({
      ...request,
      replayed: false,
      operationCommittedStyle: "rapid",
      currentStyle: "rapid",
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      committed: true,
      currentStyle: "rapid",
      publicActionObservation: styleContext,
    });
    expect(request).toMatchObject({
      operationId: styleContext.operationId,
      playerId: "agent-style",
      requestedStyle: "rapid",
      publicActionObservation: styleContext,
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(
      fixture.internals.playerAttackStyles.get("agent-style")?.selectedStyle,
    ).toBe("rapid");
    expect(fixture.database.savePlayer).not.toHaveBeenCalled();
  });

  it("retries an ambiguous commit with the byte-equivalent request", async () => {
    const fixture = createFixture();
    fixture.commitAttackStyleOperationAsync
      .mockRejectedValueOnce(new Error("connection reset after commit"))
      .mockImplementationOnce(async (request) => ({
        ...request,
        replayed: true,
        operationCommittedStyle: request.requestedStyle,
        currentStyle: request.requestedStyle,
      }));

    await expect(
      fixture.system.changeAttackStyleAtomic(
        "agent-style",
        "rapid",
        styleContext,
      ),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    expect(fixture.commitAttackStyleOperationAsync).toHaveBeenCalledTimes(2);
    expect(fixture.commitAttackStyleOperationAsync.mock.calls[0]![0]).toEqual(
      fixture.commitAttackStyleOperationAsync.mock.calls[1]![0],
    );
  });

  it("rejects a weapon-incompatible style before persistence", async () => {
    const fixture = createFixture();
    await expect(
      fixture.system.changeAttackStyleAtomic("agent-style", "aggressive"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "style_not_available",
      currentStyle: "accurate",
    });
    expect(fixture.commitAttackStyleOperationAsync).not.toHaveBeenCalled();
    expect(
      fixture.internals.playerAttackStyles.get("agent-style")?.selectedStyle,
    ).toBe("accurate");
  });

  it("rejects a mismatched public style identity before persistence", async () => {
    const fixture = createFixture();
    await expect(
      fixture.system.changeAttackStyleAtomic("agent-style", "rapid", {
        ...styleContext,
        actorId: "different-agent",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_request" });
    expect(fixture.commitAttackStyleOperationAsync).not.toHaveBeenCalled();
  });

  it("accepts the public longrange style for a bow", async () => {
    const fixture = createFixture();
    const context = {
      ...styleContext,
      operationId: "00000000-0000-4000-8000-000000000502",
      style: "longrange",
    } as const;

    await expect(
      fixture.system.changeAttackStyleAtomic(
        "agent-style",
        "longrange",
        context,
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      currentStyle: "longrange",
      publicActionObservation: context,
    });
  });

  it("does not overwrite newer live authority when an old operation is replayed", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: true,
      operationCommittedStyle: "rapid",
      currentStyle: "longrange",
    }));
    await expect(
      fixture.system.changeAttackStyleAtomic(
        "agent-style",
        "rapid",
        styleContext,
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      reason: "operation_superseded",
      currentStyle: "longrange",
    });
    expect(
      fixture.internals.playerAttackStyles.get("agent-style")?.selectedStyle,
    ).toBe("accurate");
  });
});
