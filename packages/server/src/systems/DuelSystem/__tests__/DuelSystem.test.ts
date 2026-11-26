/**
 * DuelSystem Unit Tests
 *
 * Tests the complete duel state machine:
 * - Challenge creation and acceptance
 * - State transitions: RULES → STAKES → CONFIRMING → COUNTDOWN → FIGHTING → FINISHED
 * - Rule toggling and validation
 * - Equipment restriction toggling
 * - Stake operations (add/remove)
 * - Combat outcomes (death, forfeit)
 * - Error handling and edge cases
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  beforeAll,
} from "vitest";
import {
  EventType,
  PlayerEntity,
  getDuelArenaConfig,
  DataManager,
  getDuelArenaEgressPosition,
} from "@hyperforge/shared";
import { DuelSystem } from "../index";
import { createMockWorld, createDuelPlayers, type MockWorld } from "./mocks";
import {
  STREAMING_DUEL_ARENA_ID,
  STREAMING_DUEL_ARENA_RESERVATION_ID,
} from "../streaming-arena";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

// Helper to create a challenge with proper parameters
function createTestChallenge(
  duelSystem: DuelSystem,
  challengerId: string,
  challengerName: string,
  targetId: string,
  targetName: string,
  combatLevel: number = 100,
) {
  return duelSystem.createChallenge(
    challengerId,
    challengerName,
    `socket-${challengerId}`, // challengerSocketId
    combatLevel,
    targetId,
    targetName,
  );
}

function installAuthoritativePlayerEntity(
  world: MockWorld,
  playerId: string,
  name: string,
): PlayerEntity {
  const skill = { level: 1, xp: 0 };
  const entity = new PlayerEntity(
    {
      ...world,
      stage: { scene: { add: vi.fn() } },
    } as never,
    {
      id: playerId,
      type: "player",
      name,
      playerId,
      playerName: name,
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
  return entity;
}

async function flushLifecyclePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("DuelSystem", () => {
  let world: MockWorld;
  let duelSystem: DuelSystem;

  /** Advance game ticks. Countdown needs 5 ticks (3000ms at 600ms/tick). */
  function advanceTicks(n: number): void {
    for (let i = 0; i < n; i++) {
      duelSystem.processTick();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    world = createMockWorld();
    const [player1, player2] = createDuelPlayers();
    world.addPlayer(player1);
    world.addPlayer(player2);
    duelSystem = new DuelSystem(world as never);
    duelSystem.init();
  });

  afterEach(() => {
    duelSystem.destroy();
    vi.useRealTimers();
  });

  // ============================================================================
  // Challenge Flow
  // ============================================================================

  describe("streaming arena ownership", () => {
    it("holds arena 1 outside ordinary allocation for the server lifetime", () => {
      const previous = process.env.STREAMING_DUEL_ENABLED;
      process.env.STREAMING_DUEL_ENABLED = "true";
      const streamingWorld = createMockWorld();
      const streamingDuelSystem = new DuelSystem(streamingWorld as never);

      try {
        streamingDuelSystem.init();
        expect(
          streamingDuelSystem.arenaPool.getDuelIdForArena(
            STREAMING_DUEL_ARENA_ID,
          ),
        ).toBe(STREAMING_DUEL_ARENA_RESERVATION_ID);
        expect(streamingDuelSystem.arenaPool.totalArenas).toBe(1);
        expect(streamingDuelSystem.reserveArena("ordinary-duel")).toBeNull();

        streamingDuelSystem.destroy();
        expect(
          streamingDuelSystem.arenaPool.getDuelIdForArena(
            STREAMING_DUEL_ARENA_ID,
          ),
        ).toBeNull();
        expect(streamingDuelSystem.reserveArena("after-stream-teardown")).toBe(
          1,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.STREAMING_DUEL_ENABLED;
        } else {
          process.env.STREAMING_DUEL_ENABLED = previous;
        }
      }
    });

    it("fails startup closed when streaming arena ownership is contested", () => {
      const previous = process.env.STREAMING_DUEL_ENABLED;
      process.env.STREAMING_DUEL_ENABLED = "true";
      const contestedWorld = createMockWorld();
      const contestedDuelSystem = new DuelSystem(contestedWorld as never);
      contestedDuelSystem.arenaPool.reserveSpecificArena(
        STREAMING_DUEL_ARENA_ID,
        "unexpected-owner",
      );

      try {
        expect(() => contestedDuelSystem.init()).toThrow(
          /refusing to start with split arena ownership/,
        );
      } finally {
        contestedDuelSystem.destroy();
        if (previous === undefined) {
          delete process.env.STREAMING_DUEL_ENABLED;
        } else {
          process.env.STREAMING_DUEL_ENABLED = previous;
        }
      }
    });
  });

  describe("createChallenge", () => {
    it("creates a challenge successfully", () => {
      const result = createTestChallenge(
        duelSystem,
        "player1",
        "TestPlayer1",
        "player2",
        "TestPlayer2",
      );

      expect(result.success).toBe(true);
      expect(result.challengeId).toBeDefined();
    });

    it("rejects self-challenge", () => {
      const result = createTestChallenge(
        duelSystem,
        "player1",
        "TestPlayer1",
        "player1",
        "TestPlayer1",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("can't challenge yourself");
    });

    it("rejects if challenger already in duel", () => {
      // Accept a challenge to create a duel session
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      if (challenge.success && challenge.challengeId) {
        duelSystem.respondToChallenge(challenge.challengeId, "player2", true);
      }

      // Try to challenge another player
      world.addPlayer({ id: "player3", position: { x: 70, y: 0, z: 70 } });
      const result = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player3",
        "P3",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("already in a duel");
    });

    it("rejects if target already in duel", () => {
      world.addPlayer({ id: "player3", position: { x: 70, y: 0, z: 70 } });

      // Create a duel with player2
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      if (challenge.success && challenge.challengeId) {
        duelSystem.respondToChallenge(challenge.challengeId, "player2", true);
      }

      // Try to challenge player2 from player3
      const result = createTestChallenge(
        duelSystem,
        "player3",
        "P3",
        "player2",
        "P2",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("already in a duel");
    });
  });

  describe("respondToChallenge", () => {
    it("accepts challenge and creates duel session", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      expect(challenge.success).toBe(true);

      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );

      expect(response.success).toBe(true);
      expect(response.duelId).toBeDefined();
    });

    it("declines challenge", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );

      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        false,
      );

      expect(response.success).toBe(true);
      expect(response.duelId).toBeUndefined();
    });

    it("returns error for non-existent challenge", () => {
      const response = duelSystem.respondToChallenge(
        "nonexistent",
        "player2",
        true,
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain("not found");
    });
  });

  // ============================================================================
  // Duel Session Queries
  // ============================================================================

  describe("getDuelSession", () => {
    it("returns session by ID", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );

      const session = duelSystem.getDuelSession(response.duelId!);

      expect(session).toBeDefined();
      expect(session!.duelId).toBe(response.duelId);
      expect(session!.state).toBe("RULES");
    });

    it("returns undefined for non-existent session", () => {
      const session = duelSystem.getDuelSession("nonexistent");
      expect(session).toBeUndefined();
    });
  });

  describe("getPlayerDuel", () => {
    it("returns session for player in duel", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      duelSystem.respondToChallenge(challenge.challengeId!, "player2", true);

      const session = duelSystem.getPlayerDuel("player1");

      expect(session).toBeDefined();
      expect(session!.challengerId).toBe("player1");
    });

    it("returns undefined for player not in duel", () => {
      const session = duelSystem.getPlayerDuel("player1");
      expect(session).toBeUndefined();
    });
  });

  describe("isPlayerInDuel", () => {
    it("returns true when player is in duel", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      duelSystem.respondToChallenge(challenge.challengeId!, "player2", true);

      expect(duelSystem.isPlayerInDuel("player1")).toBe(true);
      expect(duelSystem.isPlayerInDuel("player2")).toBe(true);
    });

    it("returns false when player is not in duel", () => {
      expect(duelSystem.isPlayerInDuel("player1")).toBe(false);
    });
  });

  // ============================================================================
  // State Machine: RULES
  // ============================================================================

  describe("toggleRule", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("toggles a rule successfully", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      const initialValue = session.rules.noRanged;

      const result = duelSystem.toggleRule(duelId, "player1", "noRanged");

      expect(result.success).toBe(true);
      expect(session.rules.noRanged).toBe(!initialValue);
    });

    it("resets acceptance when rule changes", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      // Manually set acceptance to simulate player having accepted
      session.challengerAccepted = true;

      duelSystem.toggleRule(duelId, "player1", "noRanged");

      expect(session.challengerAccepted).toBe(false);
      expect(session.targetAccepted).toBe(false);
    });

    it("rejects invalid rule combination (noForfeit + noMovement)", () => {
      // Enable noForfeit
      duelSystem.toggleRule(duelId, "player1", "noForfeit");

      // Try to also enable noMovement (invalid combination)
      const result = duelSystem.toggleRule(duelId, "player1", "noMovement");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("No Forfeit");
    });

    it("rejects toggle when not in RULES state", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "STAKES"; // Manually change state

      const result = duelSystem.toggleRule(duelId, "player1", "noRanged");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot modify rules");
    });

    it("rejects toggle from non-participant", () => {
      const result = duelSystem.toggleRule(duelId, "player3", "noRanged");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in this duel");
    });
  });

  describe("toggleEquipmentRestriction", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("toggles equipment restriction successfully", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      const initialValue = session.equipmentRestrictions.weapon;

      const result = duelSystem.toggleEquipmentRestriction(
        duelId,
        "player1",
        "weapon",
      );

      expect(result.success).toBe(true);
      expect(session.equipmentRestrictions.weapon).toBe(!initialValue);
    });

    it("resets acceptance when equipment restriction changes", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.challengerAccepted = true;

      duelSystem.toggleEquipmentRestriction(duelId, "player1", "head");

      expect(session.challengerAccepted).toBe(false);
      expect(session.targetAccepted).toBe(false);
    });
  });

  describe("acceptRules", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("accepts rules for one player", () => {
      const result = duelSystem.acceptRules(duelId, "player1");
      const session = duelSystem.getDuelSession(duelId)!;

      expect(result.success).toBe(true);
      expect(session.challengerAccepted).toBe(true);
      expect(session.targetAccepted).toBe(false);
      expect(session.state).toBe("RULES"); // Still in RULES
    });

    it("transitions to STAKES when both accept", () => {
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");

      const session = duelSystem.getDuelSession(duelId)!;

      expect(session.state).toBe("STAKES");
      expect(session.challengerAccepted).toBe(false); // Reset for next screen
      expect(session.targetAccepted).toBe(false);
    });
  });

  // ============================================================================
  // State Machine: STAKES
  // ============================================================================

  describe("addStake", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      // Move to STAKES state
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
    });

    it("adds stake successfully", () => {
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );

      expect(result.success).toBe(true);

      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.challengerStakes).toHaveLength(1);
      expect(session.challengerStakes[0].itemId).toBe("bronze_shortsword");
    });

    it("resets acceptance when stake added", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.challengerAccepted = true;

      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);

      expect(session.challengerAccepted).toBe(false);
    });

    it("rejects duplicate inventory slot", () => {
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "iron_shortsword",
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("already staked");
    });

    it("rejects stake when not in STAKES state", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "CONFIRMING";

      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot modify stakes");
    });
  });

  describe("removeStake", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");

      // Add a stake to remove
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
    });

    it("removes stake successfully", () => {
      const result = duelSystem.removeStake(duelId, "player1", 0);

      expect(result.success).toBe(true);

      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.challengerStakes).toHaveLength(0);
    });

    it("resets acceptance when stake removed", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.challengerAccepted = true;

      duelSystem.removeStake(duelId, "player1", 0);

      expect(session.challengerAccepted).toBe(false);
    });

    it("rejects invalid stake index", () => {
      const result = duelSystem.removeStake(duelId, "player1", 99);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid stake index");
    });
  });

  describe("acceptStakes", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
    });

    it("transitions to CONFIRMING when both accept", () => {
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");

      const session = duelSystem.getDuelSession(duelId)!;

      expect(session.state).toBe("CONFIRMING");
    });
  });

  // ============================================================================
  // State Machine: CONFIRMING → COUNTDOWN
  // ============================================================================

  describe("acceptFinal", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      // Progress through screens
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
    });

    it("transitions to COUNTDOWN when both accept", () => {
      duelSystem.acceptFinal(duelId, "player1");
      const result = duelSystem.acceptFinal(duelId, "player2");

      expect(result.success).toBe(true);
      expect(result.arenaId).toBeDefined();

      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.state).toBe("COUNTDOWN");
      expect(session.arenaId).toBe(result.arenaId);
    });

    it("reserves arena on confirmation", () => {
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      const session = duelSystem.getDuelSession(duelId)!;
      expect(duelSystem.arenaPool.isArenaAvailable(session.arenaId!)).toBe(
        false,
      );
    });
  });

  // ============================================================================
  // State Machine: COUNTDOWN → FIGHTING
  // ============================================================================

  describe("processTick - countdown", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      // Progress to COUNTDOWN
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
    });

    it("transitions to FIGHTING after countdown completes", () => {
      // Advance 5 ticks (3000ms at 600ms/tick) to complete countdown
      advanceTicks(5);

      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.state).toBe("FIGHTING");
    });

    it("emits countdown ticks", () => {
      // 2 ticks (1200ms) → countdown shows "2"
      advanceTicks(2);

      expect(world._emit).toHaveBeenCalledWith(
        "duel:countdown:tick",
        expect.objectContaining({ count: 2 }),
      );

      // 2 more ticks (2400ms total) → countdown shows "1"
      advanceTicks(2);

      expect(world._emit).toHaveBeenCalledWith(
        "duel:countdown:tick",
        expect.objectContaining({ count: 1 }),
      );
    });

    it("keeps combat closed until both prayer restores commit", async () => {
      installAuthoritativePlayerEntity(world, "player1", "P1");
      installAuthoritativePlayerEntity(world, "player2", "P2");
      const resolvers = new Map<
        string,
        (receipt: { success: boolean; reason?: string }) => void
      >();
      const restorePrayerPoints = vi.fn(
        (playerId: string) =>
          new Promise<{ success: boolean; reason?: string }>((resolve) => {
            resolvers.set(playerId, resolve);
          }),
      );
      world.getSystem.mockImplementation((name: string) =>
        name === "prayer"
          ? { restorePrayerPoints, getMaxPrayerPoints: () => 10 }
          : null,
      );

      advanceTicks(5);

      expect(duelSystem.getDuelSession(duelId)?.state).toBe("COUNTDOWN");
      expect(world._emit).not.toHaveBeenCalledWith(
        "duel:fight:start",
        expect.anything(),
      );
      expect(restorePrayerPoints).toHaveBeenCalledTimes(2);
      expect(restorePrayerPoints).toHaveBeenCalledWith(
        "player1",
        10,
        `ordinary-duel-start-prayer:${duelId}:player1`,
      );

      resolvers.get("player1")?.({ success: true });
      await flushLifecyclePromises();
      expect(duelSystem.getDuelSession(duelId)?.state).toBe("COUNTDOWN");

      resolvers.get("player2")?.({ success: true });
      await flushLifecyclePromises();
      expect(duelSystem.getDuelSession(duelId)?.state).toBe("FIGHTING");
      expect(world._emit).toHaveBeenCalledWith(
        "duel:fight:start",
        expect.objectContaining({ duelId }),
      );
    });

    it("cancels before combat when a prayer restore is rejected", async () => {
      installAuthoritativePlayerEntity(world, "player1", "P1");
      installAuthoritativePlayerEntity(world, "player2", "P2");
      world.getSystem.mockImplementation((name: string) =>
        name === "prayer"
          ? {
              restorePrayerPoints: vi.fn(async (playerId: string) =>
                playerId === "player1"
                  ? { success: false, reason: "persistence_failed" }
                  : { success: true },
              ),
              getMaxPrayerPoints: () => 10,
            }
          : null,
      );

      advanceTicks(5);
      await flushLifecyclePromises();

      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
      expect(world._emit).not.toHaveBeenCalledWith(
        "duel:fight:start",
        expect.anything(),
      );
      expect(world._emit).toHaveBeenCalledWith(
        "duel:cancelled",
        expect.objectContaining({ duelId, reason: "prayer_restore_failed" }),
      );
    });

    it("does not start a delayed fight after system teardown", async () => {
      installAuthoritativePlayerEntity(world, "player1", "P1");
      installAuthoritativePlayerEntity(world, "player2", "P2");
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

      advanceTicks(5);
      duelSystem.destroy();
      world._emit.mockClear();

      resolvers.get("player1")?.({ success: true });
      resolvers.get("player2")?.({ success: true });
      await flushLifecyclePromises();

      expect(world._emit).not.toHaveBeenCalledWith(
        "duel:fight:start",
        expect.anything(),
      );
    });
  });

  describe("processTick - combat arena ejection", () => {
    function getCombatArenaPosition() {
      const config = getDuelArenaConfig();
      return {
        x: config.baseX + Math.max(1, Math.floor(config.arenaWidth / 2)),
        y: 0,
        z: config.baseZ + Math.max(1, Math.floor(config.arenaLength / 2)),
      };
    }

    it("teleports non-dueling players out of combat arenas", () => {
      const arenaPos = getCombatArenaPosition();

      world.setPlayerPosition("player1", arenaPos.x, arenaPos.y, arenaPos.z);
      world._emit.mockClear();

      duelSystem.processTick();

      const teleports = world._emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "player:teleport",
      );
      expect(teleports).toHaveLength(1);
      // Egress remains on the shared island lobby floor, outside every combat ring.
      expect(teleports[0][1]).toEqual(
        expect.objectContaining({
          playerId: "player1",
          position: getDuelArenaEgressPosition(),
        }),
      );
    });

    it("does not sample procedural terrain when nobody needs ejection", () => {
      const getHeightAt = vi.fn(() => 7);
      world.getSystem.mockReturnValue({ getHeightAt });

      duelSystem.processTick();

      expect(getHeightAt).not.toHaveBeenCalled();
    });

    it("uses the shared authored egress height for an entire ejection batch", () => {
      const arenaPos = getCombatArenaPosition();
      const getHeightAt = vi.fn(() => 7);
      world.getSystem.mockReturnValue({ getHeightAt });
      world.setPlayerPosition("player1", arenaPos.x, arenaPos.y, arenaPos.z);
      world.setPlayerPosition(
        "player2",
        arenaPos.x + 1,
        arenaPos.y,
        arenaPos.z,
      );
      world.addPlayer({
        id: "player3",
        position: { x: arenaPos.x + 2, y: arenaPos.y, z: arenaPos.z },
      });
      world._emit.mockClear();

      duelSystem.processTick();

      expect(getHeightAt).not.toHaveBeenCalled();
      const teleports = world._emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "player:teleport",
      );
      expect(teleports).toHaveLength(3);
      expect(
        teleports.every(
          (call: unknown[]) =>
            (call[1] as { position?: { y?: number } }).position?.y ===
            getDuelArenaEgressPosition().y,
        ),
      ).toBe(true);
    });

    it("prunes expired per-player ejection cooldowns", () => {
      const arenaPos = getCombatArenaPosition();
      world.setPlayerPosition("player1", arenaPos.x, arenaPos.y, arenaPos.z);
      duelSystem.processTick();
      expect(
        (duelSystem as unknown as { _ejectionCooldowns: Map<string, number> })
          ._ejectionCooldowns.size,
      ).toBe(1);

      world.setPlayerPosition("player1", 0, 0, 0);
      vi.advanceTimersByTime(30_000);
      duelSystem.processTick();

      expect(
        (duelSystem as unknown as { _ejectionCooldowns: Map<string, number> })
          ._ejectionCooldowns.size,
      ).toBe(0);
    });

    it("does not teleport players who are in a duel session", () => {
      const arenaPos = getCombatArenaPosition();
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      duelSystem.respondToChallenge(challenge.challengeId!, "player2", true);

      world.setPlayerPosition("player1", arenaPos.x, arenaPos.y, arenaPos.z);
      world._emit.mockClear();

      duelSystem.processTick();

      const player1Teleports = world._emit.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "player:teleport" &&
          (call[1] as { playerId?: string } | undefined)?.playerId ===
            "player1",
      );
      expect(player1Teleports).toHaveLength(0);
    });

    it("does not teleport players marked in streaming/pvp duels", () => {
      const arenaPos = getCombatArenaPosition();
      const player = world.entities.players.get("player1") as
        { data?: { inStreamingDuel?: boolean } } | undefined;
      if (player) {
        player.data = { inStreamingDuel: true };
      }

      world.setPlayerPosition("player1", arenaPos.x, arenaPos.y, arenaPos.z);
      world._emit.mockClear();

      duelSystem.processTick();

      const player1Teleports = world._emit.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "player:teleport" &&
          (call[1] as { playerId?: string } | undefined)?.playerId ===
            "player1",
      );
      expect(player1Teleports).toHaveLength(0);
    });
  });

  // ============================================================================
  // State Machine: FIGHTING → FINISHED
  // ============================================================================

  describe("forfeitDuel", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      // Progress to FIGHTING
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      advanceTicks(6);
    });

    it("allows forfeit during FIGHTING", () => {
      const result = duelSystem.forfeitDuel("player1");

      expect(result.success).toBe(true);

      // Session should be cleaned up
      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
      expect(duelSystem.isPlayerInDuel("player1")).toBe(false);
    });

    it("rejects forfeit when noForfeit rule is active", () => {
      // Need to set up a new duel with noForfeit rule
      const session = duelSystem.getDuelSession(duelId)!;
      session.rules.noForfeit = true;

      const result = duelSystem.forfeitDuel("player1");

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot forfeit");
    });

    it("declares opponent as winner", () => {
      duelSystem.forfeitDuel("player1");

      expect(world._emit).toHaveBeenCalledWith(
        "duel:completed",
        expect.objectContaining({
          winnerId: "player2",
          loserId: "player1",
          reason: "forfeit",
        }),
      );
    });

    it("retains the finished session and arena until prayer restoration answers", async () => {
      installAuthoritativePlayerEntity(world, "player1", "P1");
      installAuthoritativePlayerEntity(world, "player2", "P2");
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
      const arenaId = duelSystem.getDuelSession(duelId)?.arenaId;
      world._emit.mockClear();

      expect(duelSystem.forfeitDuel("player1").success).toBe(true);

      expect(duelSystem.getDuelSession(duelId)?.state).toBe("FINISHED");
      expect(duelSystem.arenaPool.isArenaAvailable(arenaId!)).toBe(false);
      expect(world._emit).not.toHaveBeenCalledWith(
        "duel:completed",
        expect.anything(),
      );

      resolvers.get("player1")?.({ success: true });
      resolvers.get("player2")?.({ success: true });
      await flushLifecyclePromises();
      await flushLifecyclePromises();

      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
      expect(duelSystem.arenaPool.isArenaAvailable(arenaId!)).toBe(true);
      expect(world._emit).toHaveBeenCalledWith(
        "duel:completed",
        expect.objectContaining({ duelId, reason: "forfeit" }),
      );
    });
  });

  // ============================================================================
  // Cancel Duel
  // ============================================================================

  describe("cancelDuel", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("cancels duel and cleans up", () => {
      const result = duelSystem.cancelDuel(duelId, "player_cancelled");

      expect(result.success).toBe(true);
      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
      expect(duelSystem.isPlayerInDuel("player1")).toBe(false);
      expect(duelSystem.isPlayerInDuel("player2")).toBe(false);
    });

    it("emits cancel event", () => {
      duelSystem.cancelDuel(duelId, "player_cancelled", "player1");

      expect(world._emit).toHaveBeenCalledWith(
        "duel:cancelled",
        expect.objectContaining({
          duelId,
          reason: "player_cancelled",
          cancelledBy: "player1",
        }),
      );
    });

    it("keeps stakes in inventory on cancel (crash-safe design)", () => {
      // Add stakes
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);

      duelSystem.cancelDuel(duelId, "player_cancelled");

      // Crash-safe design: items never leave inventory during staking,
      // so no "duel:stakes:return" event is needed. Session is simply deleted.
      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
      expect(duelSystem.isPlayerInDuel("player1")).toBe(false);
    });

    it("releases arena on cancel", () => {
      // Progress to COUNTDOWN to reserve arena
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      const session = duelSystem.getDuelSession(duelId)!;
      const arenaId = session.arenaId!;

      duelSystem.cancelDuel(duelId, "player_cancelled");

      expect(duelSystem.arenaPool.isArenaAvailable(arenaId)).toBe(true);
    });
  });

  // ============================================================================
  // Rule Enforcement API
  // ============================================================================

  describe("rule enforcement", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      // Enable some rules
      duelSystem.toggleRule(duelId, "player1", "noRanged");
      duelSystem.toggleRule(duelId, "player1", "noFood");

      // Progress to FIGHTING
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      advanceTicks(6);
    });

    it("isPlayerInActiveDuel returns true during FIGHTING", () => {
      expect(duelSystem.isPlayerInActiveDuel("player1")).toBe(true);
    });

    it("canUseRanged returns false when noRanged is active", () => {
      expect(duelSystem.canUseRanged("player1")).toBe(false);
    });

    it("canUseMelee returns true when noMelee is not active", () => {
      expect(duelSystem.canUseMelee("player1")).toBe(true);
    });

    it("canEatFood returns false when noFood is active", () => {
      expect(duelSystem.canEatFood("player1")).toBe(false);
    });

    it("canMove returns false during COUNTDOWN", () => {
      // This fixture starts with a fight occupying the only arena. Retire that
      // owner normally before creating the separate countdown-boundary case.
      expect(duelSystem.cancelDuel(duelId, "test-phase-boundary").success).toBe(
        true,
      );
      expect(duelSystem.arenaPool.getAvailableCount()).toBe(1);
      // Create a new duel and progress to countdown
      world.addPlayer({ id: "player3", position: { x: 70, y: 0, z: 70 } });
      world.addPlayer({ id: "player4", position: { x: 72, y: 0, z: 70 } });

      const challenge2 = createTestChallenge(
        duelSystem,
        "player3",
        "P3",
        "player4",
        "P4",
      );
      duelSystem.respondToChallenge(challenge2.challengeId!, "player4", true);

      const session = duelSystem.getPlayerDuel("player3")!;
      session.state = "COUNTDOWN";

      expect(duelSystem.canMove("player3")).toBe(false);
    });

    it("getDuelOpponentId returns correct opponent", () => {
      expect(duelSystem.getDuelOpponentId("player1")).toBe("player2");
      expect(duelSystem.getDuelOpponentId("player2")).toBe("player1");
    });
  });

  // ============================================================================
  // Player Disconnect Handling
  // ============================================================================

  describe("onPlayerDisconnect", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("starts grace timer when player disconnects during setup", () => {
      duelSystem.onPlayerDisconnect("player1");

      // Session still exists during grace period
      const session = duelSystem.getDuelSession(duelId);
      expect(session).toBeDefined();
      expect(session!.pendingSetupDisconnect).toBeDefined();
      expect(session!.pendingSetupDisconnect!.playerId).toBe("player1");

      // Notifies opponent of disconnect
      expect(world._emit).toHaveBeenCalledWith(
        "duel:player:disconnected",
        expect.objectContaining({ playerId: "player1" }),
      );
    });

    it("cancels duel after setup disconnect grace period expires", () => {
      duelSystem.onPlayerDisconnect("player1");

      // Advance past grace period (SETUP_DISCONNECT_GRACE_TICKS = 12)
      advanceTicks(13);

      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
      expect(world._emit).toHaveBeenCalledWith(
        "duel:cancelled",
        expect.objectContaining({
          reason: "player_disconnected",
        }),
      );
    });

    it("clears setup disconnect grace on reconnect", () => {
      duelSystem.onPlayerDisconnect("player1");
      expect(
        duelSystem.getDuelSession(duelId)!.pendingSetupDisconnect,
      ).toBeDefined();

      duelSystem.onPlayerReconnect("player1");
      expect(
        duelSystem.getDuelSession(duelId)!.pendingSetupDisconnect,
      ).toBeUndefined();
    });

    it("starts disconnect timer during FIGHTING", () => {
      // Progress to FIGHTING
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      advanceTicks(6);

      duelSystem.onPlayerDisconnect("player1");

      // Session should still exist
      expect(duelSystem.getDuelSession(duelId)).toBeDefined();

      // Event should be emitted
      expect(world._emit).toHaveBeenCalledWith(
        "duel:player:disconnected",
        expect.objectContaining({
          playerId: "player1",
          timeoutMs: 30000,
        }),
      );
    });

    it("auto-forfeits after disconnect timeout", () => {
      // Progress to FIGHTING
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      advanceTicks(6);

      duelSystem.onPlayerDisconnect("player1");

      // Process enough ticks to pass DISCONNECT_TIMEOUT_TICKS (50)
      for (let i = 0; i < 51; i++) {
        duelSystem.processTick();
      }

      // Session should be resolved
      expect(world._emit).toHaveBeenCalledWith(
        "duel:completed",
        expect.objectContaining({
          winnerId: "player2",
          loserId: "player1",
        }),
      );
    });
  });

  describe("onPlayerReconnect", () => {
    it("clears disconnect timer on reconnect", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      const duelId = response.duelId!;

      // Progress to FIGHTING
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");

      advanceTicks(6);

      // Disconnect then reconnect
      duelSystem.onPlayerDisconnect("player1");
      duelSystem.onPlayerReconnect("player1");

      // Process enough ticks to pass what would be the timeout
      for (let i = 0; i < 55; i++) {
        duelSystem.processTick();
      }

      // Session should still be active (not auto-forfeited)
      expect(duelSystem.getDuelSession(duelId)).toBeDefined();
      expect(duelSystem.getDuelSession(duelId)!.state).toBe("FIGHTING");
    });
  });

  // ============================================================================
  // Cleanup
  // ============================================================================

  describe("destroy", () => {
    it("cancels all active duels", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      duelSystem.respondToChallenge(challenge.challengeId!, "player2", true);

      duelSystem.destroy();

      expect(duelSystem.isPlayerInDuel("player1")).toBe(false);
      expect(duelSystem.isPlayerInDuel("player2")).toBe(false);
    });

    it("removes all world event listeners", () => {
      duelSystem.destroy();

      expect(world.off).toHaveBeenCalledWith(
        EventType.PLAYER_LEFT,
        expect.any(Function),
      );
      expect(world.off).toHaveBeenCalledWith(
        EventType.PLAYER_LOGOUT,
        expect.any(Function),
      );
      expect(world.off).toHaveBeenCalledWith(
        EventType.ENTITY_DEATH,
        expect.any(Function),
      );
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("cancels sessions stuck in setup for too long", () => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      const duelId = response.duelId!;

      // Advance time past max session age (30 minutes)
      vi.advanceTimersByTime(31 * 60 * 1000);

      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
    });
  });

  // ============================================================================
  // Race Condition Tests
  // ============================================================================

  describe("race conditions", () => {
    let duelId: string;

    /**
     * Helper: progress a duel from RULES to FIGHTING state.
     */
    function progressToFighting(id: string): void {
      duelSystem.acceptRules(id, "player1");
      duelSystem.acceptRules(id, "player2");
      duelSystem.acceptStakes(id, "player1");
      duelSystem.acceptStakes(id, "player2");
      duelSystem.acceptFinal(id, "player1");
      duelSystem.acceptFinal(id, "player2");
      advanceTicks(6);
    }

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
      progressToFighting(duelId);
    });

    it("both players die same tick — only one resolution fires", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.state).toBe("FIGHTING");

      // Simulate two ENTITY_DEATH events in the same tick
      // First death sets state to FINISHED
      // handlePlayerDeath is private, but we can trigger via the event listener
      // Since we can't call private methods, manually set state and test forfeit guard
      session.state = "FINISHED";

      // Second death is a forfeit attempt which should be rejected
      const result = duelSystem.forfeitDuel("player2");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not started");
    });

    it("cancelDuel rejects FINISHED sessions", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "FINISHED";

      const result = duelSystem.cancelDuel(duelId, "test_cancel");

      expect(result.success).toBe(false);
      expect(result.error).toContain("already being resolved");
    });

    it("player forfeits while state is already FINISHED — rejected", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "FINISHED";

      const result = duelSystem.forfeitDuel("player1");

      expect(result.success).toBe(false);
    });

    it("disconnect during FINISHED state does NOT cancel session", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "FINISHED";

      duelSystem.onPlayerDisconnect("player1");

      // Session must still exist — resolution is pending
      const sessionAfter = duelSystem.getDuelSession(duelId);
      expect(sessionAfter).toBeDefined();
      expect(sessionAfter!.state).toBe("FINISHED");
    });

    it("disconnect + reconnect during death delay — resolution still fires", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "FINISHED";

      // Disconnect then reconnect
      duelSystem.onPlayerDisconnect("player1");
      duelSystem.onPlayerReconnect("player1");

      // Session should still exist
      expect(duelSystem.getDuelSession(duelId)).toBeDefined();
      expect(duelSystem.getDuelSession(duelId)!.state).toBe("FINISHED");
    });

    it("both players disconnect during FINISHED — session is NOT deleted", () => {
      const session = duelSystem.getDuelSession(duelId)!;
      session.state = "FINISHED";

      duelSystem.onPlayerDisconnect("player1");
      duelSystem.onPlayerDisconnect("player2");

      // Session must still exist for resolution to complete
      expect(duelSystem.getDuelSession(duelId)).toBeDefined();
    });

    it("concurrent acceptRules calls only transition once", () => {
      expect(duelSystem.cancelDuel(duelId, "test-phase-boundary").success).toBe(
        true,
      );
      expect(duelSystem.arenaPool.getAvailableCount()).toBe(1);
      // Create a new duel in RULES state
      world.addPlayer({ id: "player3", position: { x: 70, y: 0, z: 70 } });
      world.addPlayer({ id: "player4", position: { x: 72, y: 0, z: 70 } });

      const challenge2 = createTestChallenge(
        duelSystem,
        "player3",
        "P3",
        "player4",
        "P4",
      );
      const response2 = duelSystem.respondToChallenge(
        challenge2.challengeId!,
        "player4",
        true,
      );
      const duelId2 = response2.duelId!;

      // Both accept
      duelSystem.acceptRules(duelId2, "player3");
      duelSystem.acceptRules(duelId2, "player4");

      const session2 = duelSystem.getDuelSession(duelId2)!;
      expect(session2.state).toBe("STAKES");

      // Calling acceptRules again should fail (wrong state)
      const result = duelSystem.acceptRules(duelId2, "player3");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot accept rules");
    });
  });

  // ============================================================================
  // Additional Rule Enforcement Tests
  // ============================================================================

  describe("additional rule enforcement", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("canUseMagic returns false when noMagic is active", () => {
      duelSystem.toggleRule(duelId, "player1", "noMagic");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      expect(duelSystem.canUseMagic("player1")).toBe(false);
    });

    it("canUseSpecialAttack returns false when noSpecialAttack is active", () => {
      duelSystem.toggleRule(duelId, "player1", "noSpecialAttack");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      expect(duelSystem.canUseSpecialAttack("player1")).toBe(false);
    });

    it("canUsePrayer returns false when noPrayer is active", () => {
      duelSystem.toggleRule(duelId, "player1", "noPrayer");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      expect(duelSystem.canUsePrayer("player1")).toBe(false);
    });

    it("canUsePotions returns false when noPotions is active", () => {
      duelSystem.toggleRule(duelId, "player1", "noPotions");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      expect(duelSystem.canUsePotions("player1")).toBe(false);
    });

    it("canForfeit returns false when noForfeit is active", () => {
      duelSystem.toggleRule(duelId, "player1", "noForfeit");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      expect(duelSystem.canForfeit("player1")).toBe(false);
    });

    it("canMove returns false when noMovement rule is active during FIGHTING", () => {
      duelSystem.toggleRule(duelId, "player1", "noMovement");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      expect(duelSystem.canMove("player1")).toBe(false);
    });

    it("canMove returns true for player not in duel", () => {
      expect(duelSystem.canMove("nonexistent_player")).toBe(true);
    });

    it("getPlayerDuelRules returns rules during FIGHTING", () => {
      duelSystem.toggleRule(duelId, "player1", "noRanged");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(6);

      const rules = duelSystem.getPlayerDuelRules("player1");
      expect(rules).not.toBeNull();
      expect(rules!.noRanged).toBe(true);
    });

    it("getPlayerDuelRules returns null for player not in active duel", () => {
      expect(duelSystem.getPlayerDuelRules("player1")).toBeNull();
    });

    it("getPlayerDuelRules returns null during RULES state", () => {
      expect(duelSystem.getPlayerDuelRules("player1")).toBeNull();
    });
  });

  // ============================================================================
  // Invalid Rule Combinations
  // ============================================================================

  describe("invalid rule combinations", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;
    });

    it("rejects disabling all attack types (noMelee + noRanged + noMagic)", () => {
      duelSystem.toggleRule(duelId, "player1", "noMelee");
      duelSystem.toggleRule(duelId, "player1", "noRanged");
      const result = duelSystem.toggleRule(duelId, "player1", "noMagic");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot disable all attack types");
    });

    it("rejects noForfeit + funWeapons", () => {
      duelSystem.toggleRule(duelId, "player1", "noForfeit");
      const result = duelSystem.toggleRule(duelId, "player1", "funWeapons");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No Forfeit");
    });
  });

  // ============================================================================
  // Stake Input Validation
  // ============================================================================

  describe("stake input validation", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
    });

    it("rejects quantity of zero", () => {
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        0,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid quantity");
    });

    it("rejects negative quantity", () => {
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        -5,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid quantity");
    });

    it("rejects float quantity", () => {
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1.5,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid quantity");
    });

    it("rejects NaN quantity", () => {
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        NaN,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid quantity");
    });

    it("rejects NaN stakeIndex for removeStake", () => {
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
      const result = duelSystem.removeStake(duelId, "player1", NaN);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid stake index");
    });

    it("rejects float stakeIndex for removeStake", () => {
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
      const result = duelSystem.removeStake(duelId, "player1", 0.5);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid stake index");
    });

    it("rejects negative stakeIndex for removeStake", () => {
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
      const result = duelSystem.removeStake(duelId, "player1", -1);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid stake index");
    });

    it("enforces MAX_STAKES_PER_PLAYER limit", () => {
      // Add 28 stakes (the maximum)
      for (let i = 0; i < 28; i++) {
        duelSystem.addStake(duelId, "player1", i, `item_${i}`, 1);
      }

      // 29th stake should be rejected
      const result = duelSystem.addStake(
        duelId,
        "player1",
        28,
        "extra_item",
        1,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Maximum stakes reached");
    });
  });

  // ============================================================================
  // Utility API Tests
  // ============================================================================

  describe("getStakedSlots", () => {
    let duelId: string;

    beforeEach(() => {
      const challenge = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response = duelSystem.respondToChallenge(
        challenge.challengeId!,
        "player2",
        true,
      );
      duelId = response.duelId!;

      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
    });

    it("returns staked slot numbers", () => {
      duelSystem.addStake(duelId, "player1", 3, "bronze_shortsword", 1);
      duelSystem.addStake(duelId, "player1", 7, "iron_ore", 5);

      const stakedSlots = duelSystem.getStakedSlots("player1");
      expect(stakedSlots.size).toBe(2);
      expect(stakedSlots.has(3)).toBe(true);
      expect(stakedSlots.has(7)).toBe(true);
    });

    it("returns empty set for player not in duel", () => {
      const stakedSlots = duelSystem.getStakedSlots("nonexistent");
      expect(stakedSlots.size).toBe(0);
    });

    it("returns empty set when no stakes", () => {
      const stakedSlots = duelSystem.getStakedSlots("player1");
      expect(stakedSlots.size).toBe(0);
    });
  });

  describe("getArenaSpawnPoints", () => {
    it("returns undefined for unreserved arena", () => {
      const points = duelSystem.getArenaSpawnPoints(99);
      expect(points).toBeUndefined();
    });
  });

  describe("getArenaBounds", () => {
    it("returns undefined for unreserved arena", () => {
      const bounds = duelSystem.getArenaBounds(99);
      expect(bounds).toBeUndefined();
    });
  });

  // ============================================================================
  // Cross-Duel Action Prevention
  // ============================================================================

  describe("cross-duel action prevention", () => {
    let duelId1: string;
    let duelId2: string;

    beforeEach(() => {
      // Create first duel
      const challenge1 = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      const response1 = duelSystem.respondToChallenge(
        challenge1.challengeId!,
        "player2",
        true,
      );
      duelId1 = response1.duelId!;

      // Create second duel
      world.addPlayer({ id: "player3", position: { x: 70, y: 0, z: 70 } });
      world.addPlayer({ id: "player4", position: { x: 72, y: 0, z: 70 } });
      const challenge2 = createTestChallenge(
        duelSystem,
        "player3",
        "P3",
        "player4",
        "P4",
      );
      const response2 = duelSystem.respondToChallenge(
        challenge2.challengeId!,
        "player4",
        true,
      );
      duelId2 = response2.duelId!;
    });

    it("rejects toggleRule on another player's duel", () => {
      const result = duelSystem.toggleRule(duelId2, "player1", "noRanged");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not in this duel");
    });

    it("rejects toggleEquipmentRestriction on another player's duel", () => {
      const result = duelSystem.toggleEquipmentRestriction(
        duelId2,
        "player1",
        "weapon",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not in this duel");
    });

    it("rejects addStake on another player's duel", () => {
      // Move both duels to STAKES
      duelSystem.acceptRules(duelId1, "player1");
      duelSystem.acceptRules(duelId1, "player2");
      duelSystem.acceptRules(duelId2, "player3");
      duelSystem.acceptRules(duelId2, "player4");

      const result = duelSystem.addStake(
        duelId2,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not in this duel");
    });

    it("rejects removeStake on another player's duel", () => {
      duelSystem.acceptRules(duelId1, "player1");
      duelSystem.acceptRules(duelId1, "player2");
      duelSystem.acceptRules(duelId2, "player3");
      duelSystem.acceptRules(duelId2, "player4");

      duelSystem.addStake(duelId2, "player3", 0, "bronze_shortsword", 1);

      const result = duelSystem.removeStake(duelId2, "player1", 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not in this duel");
    });

    it("rejects acceptRules on another player's duel", () => {
      const result = duelSystem.acceptRules(duelId2, "player1");
      expect(result.success).toBe(false);
    });
  });
});
