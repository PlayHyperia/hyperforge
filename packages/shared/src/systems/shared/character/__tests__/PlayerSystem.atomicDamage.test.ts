import { beforeAll, describe, expect, it, vi } from "vitest";

import { PlayerMigration } from "../../../../types/core/core";
import { EventType } from "../../../../types/events";
import type { StreamingDuelDamageObservationContext } from "../../../../types/game/streaming-duel-action-observation";
import { EventBus } from "../../infrastructure/EventBus";
import { PlayerSystem } from "../PlayerSystem";

const context = {
  operationId: "00000000-0000-4000-8000-000000000401",
  tick: 12,
  observedAt: 1_800_000_000_012,
  cycleId: "cycle-damage",
  duelId: "duel-damage",
  actorId: "agent-a",
  opponentId: "agent-b",
  phase: "FIGHTING",
  combatRole: "ranged",
  tacticalMacro: "kite",
  requestedDamage: 9,
} satisfies StreamingDuelDamageObservationContext;

describe("PlayerSystem atomic streaming-duel damage", () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Web Crypto is required for damage receipt tests");
    }
  });

  function createFixture(
    commitImplementation?: (...args: any[]) => Promise<any>,
  ) {
    const eventBus = new EventBus();
    const healthComponent = {
      data: { current: 30, max: 60, isDead: false },
    };
    const statsComponent = { data: { health: { current: 30, max: 60 } } };
    const targetEntity = {
      data: { health: 30, inStreamingDuel: true },
      setHealth: vi.fn((health: number) => {
        healthComponent.data.current = health;
        targetEntity.data.health = health;
      }),
      getComponent: vi.fn((name: string) =>
        name === "health"
          ? healthComponent
          : name === "stats"
            ? statsComponent
            : null,
      ),
    };
    const attackerEntity = { data: { health: 30, inStreamingDuel: true } };
    const commitDuelDamageOperationAsync = vi.fn(async (...args: any[]) => ({
      xpDamageAuthority: null,
      combatProgress: [],
      competitiveTerminal: null,
      ...(await (
        commitImplementation ??
        (async (request) => ({
          ...request,
          replayed: false,
          appliedDamage: 9,
          healthBefore: 30,
          healthAfter: 21,
          targetDied: false,
        }))
      )(...args)),
    }));
    const database = {
      commitDuelDamageOperationAsync,
      savePlayer: vi.fn(),
    };
    const world = {
      isServer: true,
      currentTick: 12,
      $eventBus: eventBus,
      entities: new Map([
        ["agent-a", attackerEntity],
        ["agent-b", targetEntity],
      ]),
      getPlayer: vi.fn((id: string) =>
        id === "agent-b" ? targetEntity : attackerEntity,
      ),
      getSystem: vi.fn((name: string) =>
        name === "database" ? database : undefined,
      ),
    };
    const system = new PlayerSystem(world as never);
    const player = PlayerMigration.createNewPlayer(
      "agent-b",
      "agent-b",
      "Agent B",
    );
    player.health.current = 30;
    player.health.max = 60;
    player.alive = true;
    (
      system as unknown as {
        players: Map<string, typeof player>;
        databaseSystem: typeof database;
      }
    ).players.set(player.id, player);
    (
      system as unknown as {
        databaseSystem: typeof database;
      }
    ).databaseSystem = database;
    return {
      system,
      eventBus,
      player,
      targetEntity,
      healthComponent,
      database,
      commitDuelDamageOperationAsync,
    };
  }

  it("does not mutate live health before the atomic receipt commits", async () => {
    let release: ((value: any) => void) | undefined;
    const fixture = createFixture(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = fixture.system.damagePlayerAtomic(
      "agent-b",
      9,
      "agent-a",
      context,
    );
    await vi.waitFor(() =>
      expect(fixture.commitDuelDamageOperationAsync).toHaveBeenCalledOnce(),
    );
    expect(fixture.player.health.current).toBe(30);
    expect(fixture.targetEntity.setHealth).not.toHaveBeenCalled();

    const request = fixture.commitDuelDamageOperationAsync.mock.calls[0]![0];
    release?.({
      ...request,
      replayed: false,
      appliedDamage: 9,
      healthBefore: 30,
      healthAfter: 21,
      targetDied: false,
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      committed: true,
      appliedDamage: 9,
    });
    expect(fixture.player.health.current).toBe(21);
    expect(fixture.database.savePlayer).not.toHaveBeenCalled();
  });

  it("retries an ambiguous response with the exact same request", async () => {
    const fixture = createFixture();
    fixture.commitDuelDamageOperationAsync
      .mockRejectedValueOnce(new Error("connection reset after commit"))
      .mockImplementationOnce(async (request) => ({
        ...request,
        replayed: true,
        appliedDamage: 9,
        healthBefore: 30,
        healthAfter: 21,
        targetDied: false,
        xpDamageAuthority: null,
        combatProgress: [],
        competitiveTerminal: null,
      }));

    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-a", context),
    ).resolves.toMatchObject({ ok: true, replayed: true, appliedDamage: 9 });
    expect(fixture.commitDuelDamageOperationAsync).toHaveBeenCalledTimes(2);
    expect(fixture.commitDuelDamageOperationAsync.mock.calls[0]![0]).toEqual(
      fixture.commitDuelDamageOperationAsync.mock.calls[1]![0],
    );
  });

  it("reports unknown truth after two ambiguous responses without changing identity", async () => {
    const fixture = createFixture();
    fixture.commitDuelDamageOperationAsync
      .mockRejectedValueOnce(new Error("connection reset after commit"))
      .mockRejectedValueOnce(new Error("response timeout during replay"));

    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-a", context),
    ).resolves.toMatchObject({
      ok: false,
      committed: false,
      reason: "persistence_unknown",
    });
    expect(fixture.commitDuelDamageOperationAsync).toHaveBeenCalledTimes(2);
    expect(fixture.commitDuelDamageOperationAsync.mock.calls[0]![0]).toEqual(
      fixture.commitDuelDamageOperationAsync.mock.calls[1]![0],
    );
    expect(fixture.player.health.current).toBe(30);
  });

  it("preserves unknown truth when the immediate retry cannot inspect persistence", async () => {
    const fixture = createFixture();
    fixture.commitDuelDamageOperationAsync
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockRejectedValueOnce(
        new Error("duel_damage_competitive_terminal_missing"),
      );

    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-a", context),
    ).resolves.toMatchObject({
      ok: false,
      reason: "persistence_unknown",
    });
    expect(fixture.commitDuelDamageOperationAsync).toHaveBeenCalledTimes(2);
  });

  it("binds the exact fired projectile cost into every damage retry", async () => {
    const projectileCost = {
      operationType: "projectile_rune_cost" as const,
      operationId: "spell-runes:1234567890abcdefghij",
      playerId: "agent-a",
      requestFingerprint: "ab".repeat(32),
    };
    const fixture = createFixture();
    fixture.commitDuelDamageOperationAsync
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockImplementationOnce(async (request) => ({
        ...request,
        replayed: true,
        appliedDamage: 9,
        healthBefore: 30,
        healthAfter: 21,
        targetDied: false,
        xpDamageAuthority: null,
        combatProgress: [],
        competitiveTerminal: null,
      }));

    await expect(
      fixture.system.damagePlayerAtomic(
        "agent-b",
        9,
        "agent-a",
        context,
        undefined,
        projectileCost,
      ),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    expect(fixture.commitDuelDamageOperationAsync).toHaveBeenCalledTimes(2);
    expect(fixture.commitDuelDamageOperationAsync.mock.calls[0]![0]).toEqual(
      fixture.commitDuelDamageOperationAsync.mock.calls[1]![0],
    );
    expect(
      fixture.commitDuelDamageOperationAsync.mock.calls[0]![0],
    ).toMatchObject({
      projectileCost,
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects a projectile cost not owned by the attacking player", async () => {
    const fixture = createFixture();
    await expect(
      fixture.system.damagePlayerAtomic(
        "agent-b",
        9,
        "agent-a",
        context,
        undefined,
        {
          operationType: "ammunition_shot",
          operationId: "ammunition-shot:1234567890abcdefghij",
          playerId: "different-agent",
          requestFingerprint: "cd".repeat(32),
        },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_request" });
    expect(fixture.commitDuelDamageOperationAsync).not.toHaveBeenCalled();
  });

  it("lets persistence resolve a fired projectile after an earlier hit killed the target", async () => {
    const projectileCost = {
      operationType: "ammunition_shot" as const,
      operationId: "ammunition-shot:1234567890abcdefghij",
      playerId: "agent-a",
      requestFingerprint: "ef".repeat(32),
    };
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      appliedDamage: 0,
      healthBefore: 0,
      healthAfter: 0,
      targetDied: false,
    }));
    fixture.player.alive = false;
    fixture.player.health.current = 0;

    await expect(
      fixture.system.damagePlayerAtomic(
        "agent-b",
        9,
        "agent-a",
        context,
        undefined,
        projectileCost,
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      appliedDamage: 0,
      targetDied: true,
    });
    expect(fixture.commitDuelDamageOperationAsync).toHaveBeenCalledOnce();
    expect(fixture.targetEntity.setHealth).not.toHaveBeenCalled();
  });

  it("never sends a malformed actor binding to persistence", async () => {
    const fixture = createFixture();
    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-c", context),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_request" });
    expect(fixture.commitDuelDamageOperationAsync).not.toHaveBeenCalled();
    expect(fixture.player.health.current).toBe(30);
  });

  it("does not apply the same committed operation twice", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: true,
      appliedDamage: 9,
      healthBefore: 30,
      healthAfter: 21,
      targetDied: false,
    }));
    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-a", context),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-a", context),
    ).resolves.toMatchObject({ ok: true });
    expect(fixture.player.health.current).toBe(21);
    expect(fixture.targetEntity.setHealth).toHaveBeenCalledOnce();
  });

  it("rejects combat progression on a nonlethal receipt before live mutation", async () => {
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      appliedDamage: 9,
      healthBefore: 30,
      healthAfter: 21,
      targetDied: false,
      xpDamageAuthority: 60,
      combatProgress: [
        {
          skill: "ranged",
          xpAmount: 240,
          awardedXp: 240,
          operationCommittedXp: 240,
          currentXp: 240,
          currentLevel: 3,
        },
      ],
      competitiveTerminal: null,
    }));

    await expect(
      fixture.system.damagePlayerAtomic("agent-b", 9, "agent-a", context),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      reason: "persistence_failed",
    });
    expect(fixture.player.health.current).toBe(30);
    expect(fixture.targetEntity.setHealth).not.toHaveBeenCalled();
  });

  it("binds competitive authority and returns the exact lethal terminal receipt", async () => {
    const lethalContext = {
      ...context,
      operationId: "00000000-0000-4000-8000-000000000402",
      requestedDamage: 30,
    } satisfies StreamingDuelDamageObservationContext;
    const competitiveAuthority = {
      preparationId: "00000000-0000-4000-8000-000000000403",
      fencingToken: "19",
      snapshotDigest: "ab".repeat(32),
    };
    const competitiveTerminal = {
      outcome: "win" as const,
      winnerId: "agent-a",
      loserId: "agent-b",
      winReason: "kill" as const,
      terminalAt: lethalContext.observedAt,
      seed: "42",
      replayHash: "cd".repeat(32),
    };
    const fixture = createFixture(async (request) => ({
      ...request,
      replayed: false,
      appliedDamage: 30,
      healthBefore: 30,
      healthAfter: 0,
      targetDied: true,
      xpDamageAuthority: 60,
      combatProgress: [
        {
          skill: "ranged",
          xpAmount: 240,
          awardedXp: 240,
          operationCommittedXp: 240,
          currentXp: 240,
          currentLevel: 3,
        },
        {
          skill: "constitution",
          xpAmount: 79,
          awardedXp: 79,
          operationCommittedXp: 79,
          currentXp: 79,
          currentLevel: 1,
        },
      ],
      competitiveTerminal,
    }));
    const committedProgress: unknown[] = [];
    const deaths: unknown[] = [];
    fixture.eventBus.subscribe(
      EventType.DUEL_COMBAT_PROGRESS_COMMITTED,
      (event) => committedProgress.push(event.data),
    );
    fixture.eventBus.subscribe(EventType.ENTITY_DEATH, (event) =>
      deaths.push(event.data),
    );

    await expect(
      fixture.system.damagePlayerAtomic(
        "agent-b",
        30,
        "agent-a",
        lethalContext,
        competitiveAuthority,
      ),
    ).resolves.toMatchObject({
      ok: true,
      targetDied: true,
      competitiveTerminal,
    });
    expect(
      fixture.commitDuelDamageOperationAsync.mock.calls[0]![0],
    ).toMatchObject({
      competitiveAuthority,
      attackStyle: "ranged",
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(fixture.player.health.current).toBe(0);
    expect(committedProgress).toEqual([
      expect.objectContaining({
        playerId: "agent-a",
        damageOperationId: lethalContext.operationId,
        replayed: false,
        combatProgress: expect.arrayContaining([
          expect.objectContaining({ skill: "ranged", currentXp: 240 }),
          expect.objectContaining({ skill: "constitution", currentXp: 79 }),
        ]),
      }),
    ]);
    expect(deaths).toEqual([
      expect.objectContaining({ combatProgressCommitted: true }),
    ]);
  });
});
