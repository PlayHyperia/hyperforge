/**
 * DuelCombatResolver Unit Tests
 *
 * Tests combat resolution, stake transfers, health restoration,
 * teleportation, and error resilience of the resolver.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { DuelCombatResolver } from "../DuelCombatResolver";
import { createMockWorld, createDuelPlayers, type MockWorld } from "./mocks";
import type { ServerDuelSession } from "../DuelSessionManager";
import {
  EventType,
  PlayerEntity,
  DataManager,
  getDuelArenaLobbyReturnPosition,
  createSlotNumber,
  createItemID,
} from "@hyperforge/shared";

// Stable singleton mock so tests can verify calls
const mockAuditLoggerInstance = {
  logDuelComplete: vi.fn(),
};

// Mock AuditLogger to prevent side effects and allow verification
vi.mock("../../ServerNetwork/services", () => ({
  AuditLogger: {
    getInstance: () => mockAuditLoggerInstance,
  },
  Logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { Logger } from "../../ServerNetwork/services";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

// ============================================================================
// Helpers
// ============================================================================

function createTestSession(
  overrides: Partial<ServerDuelSession> = {},
): ServerDuelSession {
  return {
    duelId: "duel-123",
    state: "FIGHTING",
    challengerId: "player1",
    challengerName: "TestPlayer1",
    targetId: "player2",
    targetName: "TestPlayer2",
    rules: {
      noRanged: false,
      noMelee: false,
      noMagic: false,
      noSpecialAttack: false,
      noFood: false,
      noPotions: false,
      noPrayer: false,
      noMovement: false,
      noForfeit: false,
      funWeapons: false,
    },
    equipmentRestrictions: {
      head: false,
      cape: false,
      amulet: false,
      weapon: false,
      body: false,
      shield: false,
      legs: false,
      gloves: false,
      boots: false,
      ring: false,
      ammo: false,
    },
    challengerStakes: [
      {
        inventorySlot: createSlotNumber(0),
        itemId: createItemID("dragon_scimitar"),
        quantity: 1,
        value: 100000,
      },
    ],
    targetStakes: [
      {
        inventorySlot: createSlotNumber(5),
        itemId: createItemID("coins"),
        quantity: 100000,
        value: 100000,
      },
    ],
    challengerAccepted: true,
    targetAccepted: true,
    arenaId: 0,
    createdAt: Date.now(),
    fightStartedAt: Date.now(),
    ...overrides,
  };
}

function installAuthoritativePlayerEntity(
  world: MockWorld,
  playerId: string,
): void {
  const skill = { level: 1, xp: 0 };
  const entity = new PlayerEntity(
    { ...world, stage: { scene: { add: vi.fn() } } } as never,
    {
      id: playerId,
      type: "player",
      name: playerId,
      playerId,
      playerName: playerId,
      level: 1,
      health: 10,
      maxHealth: 10,
      stamina: 100,
      maxStamina: 100,
      combatStyle: "attack",
      equipment: {},
      inventory: [],
      skills: {
        attack: skill,
        strength: skill,
        defense: skill,
        constitution: { level: 10, xp: 0 },
        ranged: skill,
        magic: skill,
        prayer: skill,
        woodcutting: skill,
        mining: skill,
        fishing: skill,
        firemaking: skill,
        cooking: skill,
        smithing: skill,
        agility: skill,
        crafting: skill,
        fletching: skill,
        runecrafting: skill,
      },
      position: [70, 0, 70],
      quaternion: [0, 0, 0, 1],
    } as never,
  );
  (world.entities.players as unknown as Map<string, PlayerEntity>).set(
    playerId,
    entity,
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("DuelCombatResolver", () => {
  let world: MockWorld;
  let resolver: DuelCombatResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    world = createMockWorld();
    const [player1, player2] = createDuelPlayers();
    world.addPlayer(player1);
    world.addPlayer(player2);
    resolver = new DuelCombatResolver(world as never);
  });

  // ==========================================================================
  // resolveDuel — Session State
  // ==========================================================================

  describe("resolveDuel - session state", () => {
    it("sets session to FINISHED state", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      expect(session.state).toBe("FINISHED");
    });

    it("sets winnerId on session", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      expect(session.winnerId).toBe("player1");
    });

    it("sets finishedAt timestamp", () => {
      const session = createTestSession();
      const before = Date.now();

      resolver.resolveDuel(session, "player1", "player2", "death");

      expect(session.finishedAt).toBeGreaterThanOrEqual(before);
      expect(session.finishedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  // ==========================================================================
  // resolveDuel — Return Value
  // ==========================================================================

  describe("resolveDuel - return value", () => {
    it("returns correct DuelResolutionResult shape", () => {
      const session = createTestSession();

      const result = resolver.resolveDuel(
        session,
        "player1",
        "player2",
        "death",
      );

      expect(result).toEqual({
        winnerId: "player1",
        winnerName: "TestPlayer1",
        loserId: "player2",
        loserName: "TestPlayer2",
        reason: "death",
        winnerReceives: session.targetStakes,
        winnerReceivesValue: 100000,
      });
    });

    it("returns correct names when target wins", () => {
      const session = createTestSession();

      const result = resolver.resolveDuel(
        session,
        "player2",
        "player1",
        "forfeit",
      );

      expect(result.winnerName).toBe("TestPlayer2");
      expect(result.loserName).toBe("TestPlayer1");
      expect(result.reason).toBe("forfeit");
      expect(result.winnerReceives).toBe(session.challengerStakes);
    });

    it("returns 0 value when loser has no stakes", () => {
      const session = createTestSession({ targetStakes: [] });

      const result = resolver.resolveDuel(
        session,
        "player1",
        "player2",
        "death",
      );

      expect(result.winnerReceivesValue).toBe(0);
      expect(result.winnerReceives).toEqual([]);
    });
  });

  // ==========================================================================
  // resolveDuel — Event Emissions
  // ==========================================================================

  describe("resolveDuel - events", () => {
    it("emits duel:stakes:transfer with correct data", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const transferCall = world.emit.mock.calls.find(
        (c: unknown[]) => c[0] === "duel:stakes:transfer",
      );
      expect(transferCall).toBeDefined();
      expect(transferCall![1]).toMatchObject({
        winnerId: "player1",
        loserId: "player2",
        duelId: "duel-123",
      });
    });

    it("emits duel:stakes:settle with combined stakes", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const settleCall = world.emit.mock.calls.find(
        (c: unknown[]) => c[0] === "duel:stakes:settle",
      );
      expect(settleCall).toBeDefined();
      expect(settleCall![1]).toMatchObject({
        playerId: "player1",
        fromPlayerId: "player2",
        reason: "duel_won",
      });
    });

    it("emits PLAYER_RESPAWNED for both players", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const respawnCalls = world.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === EventType.PLAYER_RESPAWNED,
      );
      expect(respawnCalls.length).toBe(2);

      const winnerRespawn = respawnCalls.find(
        (c: unknown[]) => (c[1] as { playerId: string }).playerId === "player1",
      );
      const loserRespawn = respawnCalls.find(
        (c: unknown[]) => (c[1] as { playerId: string }).playerId === "player2",
      );
      expect(winnerRespawn).toBeDefined();
      expect(loserRespawn).toBeDefined();
      expect(
        (winnerRespawn![1] as { spawnPosition: unknown }).spawnPosition,
      ).toEqual(getDuelArenaLobbyReturnPosition(true));
      expect(
        (loserRespawn![1] as { spawnPosition: unknown }).spawnPosition,
      ).toEqual(getDuelArenaLobbyReturnPosition(false));
    });

    it("emits PLAYER_SET_DEAD false for both players", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const deadCalls = world.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === EventType.PLAYER_SET_DEAD,
      );
      expect(deadCalls.length).toBe(2);
      for (const call of deadCalls) {
        expect((call[1] as { isDead: boolean }).isDead).toBe(false);
      }
    });

    it("emits player:teleport for winner with getDuelArenaLobbyReturnPosition(true)", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const teleportCalls = world.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === "player:teleport",
      );
      const winnerTeleport = teleportCalls.find(
        (c: unknown[]) => (c[1] as { playerId: string }).playerId === "player1",
      );
      expect(winnerTeleport).toBeDefined();
      expect((winnerTeleport![1] as { position: unknown }).position).toEqual(
        getDuelArenaLobbyReturnPosition(true),
      );
    });

    it("emits player:teleport for loser with getDuelArenaLobbyReturnPosition(false)", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const teleportCalls = world.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === "player:teleport",
      );
      const loserTeleport = teleportCalls.find(
        (c: unknown[]) => (c[1] as { playerId: string }).playerId === "player2",
      );
      expect(loserTeleport).toBeDefined();
      expect((loserTeleport![1] as { position: unknown }).position).toEqual(
        getDuelArenaLobbyReturnPosition(false),
      );
    });

    it("emits duel:completed with correct data", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      const completedCall = world.emit.mock.calls.find(
        (c: unknown[]) => c[0] === "duel:completed",
      );
      expect(completedCall).toBeDefined();
      expect(completedCall![1]).toMatchObject({
        duelId: "duel-123",
        winnerId: "player1",
        winnerName: "TestPlayer1",
        loserId: "player2",
        loserName: "TestPlayer2",
        reason: "death",
        forfeit: false,
        challengerId: "player1",
        opponentId: "player2",
        challengerStakeValue: 100000,
        opponentStakeValue: 100000,
      });
    });

    it("sets forfeit=true when reason is forfeit", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "forfeit");

      const completedCall = world.emit.mock.calls.find(
        (c: unknown[]) => c[0] === "duel:completed",
      );
      expect((completedCall![1] as { forfeit: boolean }).forfeit).toBe(true);
    });

    it("calls AuditLogger.logDuelComplete", () => {
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      expect(mockAuditLoggerInstance.logDuelComplete).toHaveBeenCalledWith(
        "duel-123",
        "player1",
        "player2",
        session.targetStakes,
        session.challengerStakes,
        100000,
        "death",
      );
    });

    it("defers completion and audit until both prayer restores answer", async () => {
      installAuthoritativePlayerEntity(world, "player1");
      installAuthoritativePlayerEntity(world, "player2");
      const resolvers = new Map<
        string,
        (receipt: { success: boolean }) => void
      >();
      const restorePrayerPoints = vi.fn(
        (playerId: string) =>
          new Promise<{ success: boolean }>((resolve) => {
            resolvers.set(playerId, resolve);
          }),
      );
      world.getSystem.mockImplementation((name: string) =>
        name === "prayer"
          ? { restorePrayerPoints, getMaxPrayerPoints: () => 10 }
          : null,
      );
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");

      expect(resolver.hasPendingResolution(session.duelId)).toBe(true);
      expect(world.emit).not.toHaveBeenCalledWith(
        "duel:completed",
        expect.anything(),
      );
      expect(mockAuditLoggerInstance.logDuelComplete).not.toHaveBeenCalled();
      expect(world.emit).toHaveBeenCalledWith(
        "player:teleport",
        expect.objectContaining({ playerId: "player1" }),
      );
      expect(restorePrayerPoints).toHaveBeenCalledWith(
        "player1",
        10,
        `ordinary-duel-resolution-prayer:${session.duelId}:player1`,
      );

      resolvers.get("player1")?.({ success: true });
      await Promise.resolve();
      expect(world.emit).not.toHaveBeenCalledWith(
        "duel:completed",
        expect.anything(),
      );

      resolvers.get("player2")?.({ success: true });
      await resolver.waitForResolution(session.duelId);
      expect(world.emit).toHaveBeenCalledWith(
        "duel:completed",
        expect.objectContaining({ duelId: session.duelId }),
      );
      expect(mockAuditLoggerInstance.logDuelComplete).toHaveBeenCalledOnce();
    });

    it("suppresses delayed completion and audit after resolver teardown", async () => {
      installAuthoritativePlayerEntity(world, "player1");
      installAuthoritativePlayerEntity(world, "player2");
      const resolvers = new Map<
        string,
        (receipt: { success: boolean }) => void
      >();
      world.getSystem.mockImplementation((name: string) =>
        name === "prayer"
          ? {
              restorePrayerPoints: (playerId: string) =>
                new Promise<{ success: boolean }>((resolve) => {
                  resolvers.set(playerId, resolve);
                }),
              getMaxPrayerPoints: () => 10,
            }
          : null,
      );
      const session = createTestSession();

      resolver.resolveDuel(session, "player1", "player2", "death");
      const pendingResolution = resolver.waitForResolution(session.duelId);
      resolver.destroy();
      world.emit.mockClear();
      mockAuditLoggerInstance.logDuelComplete.mockClear();

      resolvers.get("player1")?.({ success: true });
      resolvers.get("player2")?.({ success: true });
      await pendingResolution;

      expect(world.emit).not.toHaveBeenCalledWith(
        "duel:completed",
        expect.anything(),
      );
      expect(mockAuditLoggerInstance.logDuelComplete).not.toHaveBeenCalled();
    });

    it("does not emit duel:stakes:settle when no stakes", () => {
      const session = createTestSession({
        challengerStakes: [],
        targetStakes: [],
      });

      resolver.resolveDuel(session, "player1", "player2", "death");

      const settleCall = world.emit.mock.calls.find(
        (c: unknown[]) => c[0] === "duel:stakes:settle",
      );
      expect(settleCall).toBeUndefined();
    });
  });

  // ==========================================================================
  // resolveDuel — Error Resilience
  // ==========================================================================

  describe("resolveDuel - error resilience", () => {
    it("teleports execute even if stake transfer throws", () => {
      const session = createTestSession();
      // Make the first emit (duel:stakes:transfer) throw
      let callCount = 0;
      world.emit.mockImplementation((event: string) => {
        callCount++;
        if (event === "duel:stakes:transfer") {
          throw new Error("Transfer failed");
        }
      });

      const result = resolver.resolveDuel(
        session,
        "player1",
        "player2",
        "death",
      );

      // Should still complete with valid result
      expect(result.winnerId).toBe("player1");
      // Teleport events should still have been attempted
      const teleportCalls = world.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === "player:teleport",
      );
      expect(teleportCalls.length).toBe(2);
    });

    it("teleports execute even if health restoration throws", () => {
      const session = createTestSession();
      world.emit.mockImplementation((event: string) => {
        if (event === EventType.PLAYER_RESPAWNED) {
          throw new Error("Respawn failed");
        }
      });

      const result = resolver.resolveDuel(
        session,
        "player1",
        "player2",
        "death",
      );

      expect(result.winnerId).toBe("player1");
      const teleportCalls = world.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === "player:teleport",
      );
      expect(teleportCalls.length).toBe(2);
    });

    it("loser teleport executes even if winner teleport throws", () => {
      const session = createTestSession();
      let winnerTeleported = false;
      world.emit.mockImplementation((event: string, data: unknown) => {
        if (event === "player:teleport") {
          const payload = data as { playerId: string };
          if (payload.playerId === "player1" && !winnerTeleported) {
            winnerTeleported = true;
            throw new Error("Winner teleport failed");
          }
        }
      });

      const result = resolver.resolveDuel(
        session,
        "player1",
        "player2",
        "death",
      );

      expect(result.winnerId).toBe("player1");
      // Logger.error should have been called for the winner teleport failure
      expect(Logger.error).toHaveBeenCalledWith(
        "DuelCombatResolver",
        "Winner teleport failed",
        expect.any(Error),
        expect.objectContaining({ winnerId: "player1" }),
      );
    });

    it("audit log fires even if completion event throws", () => {
      const session = createTestSession();
      world.emit.mockImplementation((event: string) => {
        if (event === "duel:completed") {
          throw new Error("Completion event failed");
        }
      });

      resolver.resolveDuel(session, "player1", "player2", "death");

      expect(mockAuditLoggerInstance.logDuelComplete).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // returnStakedItems
  // ==========================================================================

  describe("returnStakedItems", () => {
    it("logs when stakes exist", () => {
      const session = createTestSession();

      resolver.returnStakedItems(session);

      expect(Logger.debug).toHaveBeenCalledWith(
        "DuelCombatResolver",
        "Duel cancelled - stakes remain in inventory",
        expect.objectContaining({
          duelId: "duel-123",
          challengerStakes: 1,
          targetStakes: 1,
        }),
      );
    });

    it("does nothing when no stakes", () => {
      const session = createTestSession({
        challengerStakes: [],
        targetStakes: [],
      });

      resolver.returnStakedItems(session);

      // Should not log since no stakes
      const debugCalls = (
        Logger.debug as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        (c: unknown[]) =>
          c[1] === "Duel cancelled - stakes remain in inventory",
      );
      expect(debugCalls.length).toBe(0);
    });
  });
});
