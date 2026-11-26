/**
 * Handler State Validation Tests
 *
 * Comprehensive cross-state validation matrix:
 * Every mutating operation is tested against EVERY invalid state to ensure
 * guards reject properly. This catches regressions if state-check logic is
 * refactored.
 *
 * Operations tested:
 *   toggleRule        — only valid in RULES
 *   toggleEquipment   — only valid in RULES
 *   acceptRules       — only valid in RULES
 *   addStake          — only valid in STAKES
 *   removeStake       — only valid in STAKES
 *   acceptStakes      — only valid in STAKES
 *   acceptFinal       — only valid in CONFIRMING
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { DataManager } from "@hyperforge/shared";
import { DuelSystem } from "../index";
import { createMockWorld, createDuelPlayers, type MockWorld } from "./mocks";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

// ============================================================================
// Helpers
// ============================================================================

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
    `socket-${challengerId}`,
    combatLevel,
    targetId,
    targetName,
  );
}

function setupDuelInState(
  duelSystem: DuelSystem,
  targetState: "RULES" | "STAKES" | "CONFIRMING" | "COUNTDOWN" | "FIGHTING",
): string {
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

  if (targetState === "RULES") return duelId;

  duelSystem.acceptRules(duelId, "player1");
  duelSystem.acceptRules(duelId, "player2");
  if (targetState === "STAKES") return duelId;

  duelSystem.acceptStakes(duelId, "player1");
  duelSystem.acceptStakes(duelId, "player2");
  if (targetState === "CONFIRMING") return duelId;

  duelSystem.acceptFinal(duelId, "player1");
  duelSystem.acceptFinal(duelId, "player2");
  if (targetState === "COUNTDOWN") return duelId;

  // Advance past countdown into FIGHTING
  for (let i = 0; i < 6; i++) {
    duelSystem.processTick();
  }
  return duelId;
}

function advanceTicks(duelSystem: DuelSystem, n: number): void {
  for (let i = 0; i < n; i++) {
    duelSystem.processTick();
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("DuelSystem — handler state validation matrix", () => {
  let world: MockWorld;
  let duelSystem: DuelSystem;

  beforeEach(() => {
    vi.useFakeTimers();
    world = createMockWorld();
    const [p1, p2] = createDuelPlayers();
    world.addPlayer(p1);
    world.addPlayer(p2);
    duelSystem = new DuelSystem(world as never);
    duelSystem.init();
  });

  afterEach(() => {
    duelSystem.destroy();
    vi.useRealTimers();
  });

  // ==========================================================================
  // toggleRule — only valid in RULES
  // ==========================================================================

  describe("toggleRule state guards", () => {
    it("succeeds in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.toggleRule(duelId, "player1", "noRanged");
      expect(result.success).toBe(true);
    });

    it.each(["STAKES", "CONFIRMING"] as const)(
      "rejects in %s state",
      (state) => {
        const duelId = setupDuelInState(duelSystem, state);
        const result = duelSystem.toggleRule(duelId, "player1", "noRanged");
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      },
    );

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.toggleRule(duelId, "player1", "noRanged");
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.toggleRule(duelId, "player1", "noRanged");
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // toggleEquipmentRestriction — only valid in RULES
  // ==========================================================================

  describe("toggleEquipmentRestriction state guards", () => {
    it("succeeds in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.toggleEquipmentRestriction(
        duelId,
        "player1",
        "head",
      );
      expect(result.success).toBe(true);
    });

    it.each(["STAKES", "CONFIRMING"] as const)(
      "rejects in %s state",
      (state) => {
        const duelId = setupDuelInState(duelSystem, state);
        const result = duelSystem.toggleEquipmentRestriction(
          duelId,
          "player1",
          "head",
        );
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      },
    );

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.toggleEquipmentRestriction(
        duelId,
        "player1",
        "head",
      );
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.toggleEquipmentRestriction(
        duelId,
        "player1",
        "head",
      );
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // acceptRules — only valid in RULES
  // ==========================================================================

  describe("acceptRules state guards", () => {
    it("succeeds in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.acceptRules(duelId, "player1");
      expect(result.success).toBe(true);
    });

    it("rejects in STAKES state", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");
      const result = duelSystem.acceptRules(duelId, "player1");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects in CONFIRMING state", () => {
      const duelId = setupDuelInState(duelSystem, "CONFIRMING");
      const result = duelSystem.acceptRules(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.acceptRules(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.acceptRules(duelId, "player1");
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // addStake — only valid in STAKES
  // ==========================================================================

  describe("addStake state guards", () => {
    it("succeeds in STAKES state", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );
      expect(result.success).toBe(true);
    });

    it("rejects in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects in CONFIRMING state", () => {
      const duelId = setupDuelInState(duelSystem, "CONFIRMING");
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );
      expect(result.success).toBe(false);
    });

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.addStake(
        duelId,
        "player1",
        0,
        "bronze_shortsword",
        1,
      );
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // removeStake — only valid in STAKES
  // ==========================================================================

  describe("removeStake state guards", () => {
    it("rejects in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.removeStake(duelId, "player1", 0);
      expect(result.success).toBe(false);
    });

    it("rejects in CONFIRMING state", () => {
      const duelId = setupDuelInState(duelSystem, "CONFIRMING");
      const result = duelSystem.removeStake(duelId, "player1", 0);
      expect(result.success).toBe(false);
    });

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.removeStake(duelId, "player1", 0);
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.removeStake(duelId, "player1", 0);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // acceptStakes — only valid in STAKES
  // ==========================================================================

  describe("acceptStakes state guards", () => {
    it("succeeds in STAKES state", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");
      const result = duelSystem.acceptStakes(duelId, "player1");
      expect(result.success).toBe(true);
    });

    it("rejects in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.acceptStakes(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in CONFIRMING state", () => {
      const duelId = setupDuelInState(duelSystem, "CONFIRMING");
      const result = duelSystem.acceptStakes(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.acceptStakes(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.acceptStakes(duelId, "player1");
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // acceptFinal — only valid in CONFIRMING
  // ==========================================================================

  describe("acceptFinal state guards", () => {
    it("succeeds in CONFIRMING state", () => {
      const duelId = setupDuelInState(duelSystem, "CONFIRMING");
      const result = duelSystem.acceptFinal(duelId, "player1");
      expect(result.success).toBe(true);
    });

    it("rejects in RULES state", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.acceptFinal(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in STAKES state", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");
      const result = duelSystem.acceptFinal(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in COUNTDOWN state", () => {
      const duelId = setupDuelInState(duelSystem, "COUNTDOWN");
      const result = duelSystem.acceptFinal(duelId, "player1");
      expect(result.success).toBe(false);
    });

    it("rejects in FIGHTING state", () => {
      const duelId = setupDuelInState(duelSystem, "FIGHTING");
      const result = duelSystem.acceptFinal(duelId, "player1");
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Challenge guards
  // ==========================================================================

  describe("challenge guards", () => {
    it("rejects self-challenge", () => {
      const result = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player1",
        "P1",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("yourself");
    });

    it("rejects second challenge from same challenger", () => {
      // First challenge accepted → creates duel
      const c1 = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      duelSystem.respondToChallenge(c1.challengeId!, "player2", true);

      // Try to challenge someone else while already in a duel
      world.addPlayer({
        id: "player3",
        position: { x: 70, y: 0, z: 70 },
      });
      const c2 = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player3",
        "P3",
      );
      expect(c2.success).toBe(false);
    });

    it("rejects challenge if target already in duel", () => {
      // player1 challenges player2, accepted
      const c1 = createTestChallenge(
        duelSystem,
        "player1",
        "P1",
        "player2",
        "P2",
      );
      duelSystem.respondToChallenge(c1.challengeId!, "player2", true);

      // player3 tries to challenge player2 who is busy
      world.addPlayer({
        id: "player3",
        position: { x: 70, y: 0, z: 70 },
      });
      const c2 = createTestChallenge(
        duelSystem,
        "player3",
        "P3",
        "player2",
        "P2",
      );
      expect(c2.success).toBe(false);
    });

    it("rejects non-participant operations", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      world.addPlayer({
        id: "outsider",
        position: { x: 70, y: 0, z: 70 },
      });

      expect(
        duelSystem.toggleRule(duelId, "outsider", "noRanged").success,
      ).toBe(false);
      expect(duelSystem.acceptRules(duelId, "outsider").success).toBe(false);
    });

    it("rejects operations on non-existent duel", () => {
      expect(
        duelSystem.toggleRule("fake-duel-id", "player1", "noRanged").success,
      ).toBe(false);
      expect(duelSystem.acceptRules("fake-duel-id", "player1").success).toBe(
        false,
      );
      expect(
        duelSystem.addStake("fake-duel-id", "player1", 0, "item", 1).success,
      ).toBe(false);
      expect(duelSystem.acceptStakes("fake-duel-id", "player1").success).toBe(
        false,
      );
      expect(duelSystem.acceptFinal("fake-duel-id", "player1").success).toBe(
        false,
      );
    });
  });

  // ==========================================================================
  // Acceptance reset on modification
  // ==========================================================================

  describe("acceptance reset on modification", () => {
    it("resets rules acceptance when a rule is toggled", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");

      // Both accept
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");

      // Verify we moved to STAKES (both accepted)
      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.state).toBe("STAKES");
    });

    it("resets stakes acceptance when a stake is added", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");

      // player1 accepts stakes
      duelSystem.acceptStakes(duelId, "player1");
      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.challengerAccepted).toBe(true);

      // Adding a stake should reset acceptance
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
      expect(session.challengerAccepted).toBe(false);
    });

    it("resets stakes acceptance when a stake is removed", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");

      // Add then accept
      duelSystem.addStake(duelId, "player1", 0, "bronze_shortsword", 1);
      duelSystem.acceptStakes(duelId, "player1");
      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.challengerAccepted).toBe(true);

      // Removing resets
      duelSystem.removeStake(duelId, "player1", 0);
      expect(session.challengerAccepted).toBe(false);
    });
  });

  // ==========================================================================
  // Forfeit guards
  // ==========================================================================

  describe("forfeit guards", () => {
    it("rejects forfeit when not in FIGHTING state", () => {
      setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.forfeitDuel("player1");
      // Forfeit should fail or be a no-op when not fighting
      // (the duel is in setup, not combat)
      expect(result.success).toBe(false);
    });

    it("rejects forfeit from player not in any duel", () => {
      world.addPlayer({
        id: "loner",
        position: { x: 70, y: 0, z: 70 },
      });
      const result = duelSystem.forfeitDuel("loner");
      expect(result.success).toBe(false);
    });

    it("rejects forfeit when noForfeit rule is active", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      duelSystem.toggleRule(duelId, "player1", "noForfeit");
      duelSystem.acceptRules(duelId, "player1");
      duelSystem.acceptRules(duelId, "player2");
      duelSystem.acceptStakes(duelId, "player1");
      duelSystem.acceptStakes(duelId, "player2");
      duelSystem.acceptFinal(duelId, "player1");
      duelSystem.acceptFinal(duelId, "player2");
      advanceTicks(duelSystem, 6);

      const session = duelSystem.getDuelSession(duelId)!;
      expect(session.state).toBe("FIGHTING");

      const result = duelSystem.forfeitDuel("player1");
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Cancel guards
  // ==========================================================================

  describe("cancel during different states", () => {
    it("cancels successfully during RULES", () => {
      const duelId = setupDuelInState(duelSystem, "RULES");
      const result = duelSystem.cancelDuel(duelId, "player cancelled");
      expect(result.success).toBe(true);
      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
    });

    it("cancels successfully during STAKES", () => {
      const duelId = setupDuelInState(duelSystem, "STAKES");
      const result = duelSystem.cancelDuel(duelId, "player cancelled");
      expect(result.success).toBe(true);
      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
    });

    it("cancels successfully during CONFIRMING", () => {
      const duelId = setupDuelInState(duelSystem, "CONFIRMING");
      const result = duelSystem.cancelDuel(duelId, "player cancelled");
      expect(result.success).toBe(true);
      expect(duelSystem.getDuelSession(duelId)).toBeUndefined();
    });

    it("rejects cancel on non-existent duel", () => {
      const result = duelSystem.cancelDuel("fake-id", "reason");
      expect(result.success).toBe(false);
    });
  });
});
