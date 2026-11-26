/**
 * Store Handler Integration Tests
 *
 * Tests the store handler logic with mocked socket/world dependencies.
 * Verifies distance validation and rate limiting work correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  INTERACTION_DISTANCE,
  SessionType,
  TRANSACTION_RATE_LIMIT_MS,
  INPUT_LIMITS,
} from "@hyperforge/shared";
import { IntervalRateLimiter } from "../../src/systems/ServerNetwork/services/IntervalRateLimiter";
import {
  isValidItemId,
  isValidQuantity,
  isValidStoreId,
  wouldOverflow,
} from "../../src/systems/ServerNetwork/services/InputValidation";

// Mock types
interface MockPlayer {
  id: string;
  position: { x: number; y: number; z: number };
}

interface MockSocket {
  id: string;
  player: MockPlayer;
  storeSessionEntityId?: string;
}

interface MockNPCEntity {
  id: string;
  position?: { x: number; z: number };
  base?: { position: { x: number; z: number } };
}

interface MockWorld {
  entities: Map<string, MockNPCEntity>;
}

// Simulate the distance check logic from store handler
function verifyStoreDistance(
  socket: MockSocket,
  world: MockWorld,
): string | null {
  const npcEntityId = socket.storeSessionEntityId;
  if (!npcEntityId) {
    return "Store session expired";
  }

  const npcEntity = world.entities.get(npcEntityId);
  if (!npcEntity) {
    return "Store session expired";
  }

  const npcPosition = npcEntity.position || npcEntity.base?.position;
  if (!npcPosition) {
    return "Store session expired";
  }

  const playerEntity = socket.player;
  if (!playerEntity?.position) {
    return "Player position not found";
  }

  // Chebyshev distance
  const distance = Math.max(
    Math.abs(playerEntity.position.x - npcPosition.x),
    Math.abs(playerEntity.position.z - npcPosition.z),
  );

  if (distance > INTERACTION_DISTANCE[SessionType.STORE]) {
    return "You are too far from the store";
  }

  return null;
}

describe("Store Handler Integration - Distance Validation", () => {
  let world: MockWorld;

  beforeEach(() => {
    world = {
      entities: new Map([
        ["shopkeeper-1", { id: "shopkeeper-1", position: { x: 20, z: 20 } }],
      ]),
    };
  });

  describe("Player within range", () => {
    it("allows buy when player is adjacent to shopkeeper", () => {
      const socket: MockSocket = {
        id: "socket-1",
        player: { id: "player-1", position: { x: 21, y: 0, z: 20 } },
        storeSessionEntityId: "shopkeeper-1",
      };

      expect(verifyStoreDistance(socket, world)).toBeNull();
    });

    it("allows buy when player is exactly 2 tiles away", () => {
      const socket: MockSocket = {
        id: "socket-1",
        player: { id: "player-1", position: { x: 22, y: 0, z: 20 } },
        storeSessionEntityId: "shopkeeper-1",
      };

      expect(verifyStoreDistance(socket, world)).toBeNull();
    });
  });

  describe("Player out of range - SECURITY", () => {
    it("blocks buy when player is 3 tiles away", () => {
      const socket: MockSocket = {
        id: "socket-1",
        player: { id: "player-1", position: { x: 23, y: 0, z: 20 } },
        storeSessionEntityId: "shopkeeper-1",
      };

      expect(verifyStoreDistance(socket, world)).toBe(
        "You are too far from the store",
      );
    });

    it("blocks buy when player walked away after opening store", () => {
      const socket: MockSocket = {
        id: "socket-1",
        player: { id: "player-1", position: { x: 100, y: 0, z: 100 } },
        storeSessionEntityId: "shopkeeper-1",
      };

      expect(verifyStoreDistance(socket, world)).toBe(
        "You are too far from the store",
      );
    });
  });

  describe("Session validation", () => {
    it("blocks when no store session", () => {
      const socket: MockSocket = {
        id: "socket-1",
        player: { id: "player-1", position: { x: 20, y: 0, z: 20 } },
        storeSessionEntityId: undefined,
      };

      expect(verifyStoreDistance(socket, world)).toBe("Store session expired");
    });

    it("blocks when NPC entity gone", () => {
      const socket: MockSocket = {
        id: "socket-1",
        player: { id: "player-1", position: { x: 20, y: 0, z: 20 } },
        storeSessionEntityId: "nonexistent-npc",
      };

      expect(verifyStoreDistance(socket, world)).toBe("Store session expired");
    });
  });
});

describe("Store Handler Integration - Rate Limiting", () => {
  let rateLimiter: IntervalRateLimiter;

  beforeEach(() => {
    rateLimiter = new IntervalRateLimiter(TRANSACTION_RATE_LIMIT_MS);
  });

  it("allows first operation", () => {
    expect(rateLimiter.tryOperation("player-1")).toBe(true);
  });

  it("blocks immediate second operation", () => {
    rateLimiter.tryOperation("player-1");
    expect(rateLimiter.tryOperation("player-1")).toBe(false);
  });

  it("allows operations from different players", () => {
    expect(rateLimiter.tryOperation("player-1")).toBe(true);
    expect(rateLimiter.tryOperation("player-2")).toBe(true);
    expect(rateLimiter.tryOperation("player-3")).toBe(true);
  });

  it("allows operation after cooldown expires", async () => {
    rateLimiter.tryOperation("player-1");

    // Wait for rate limit to expire
    await new Promise((r) => setTimeout(r, TRANSACTION_RATE_LIMIT_MS + 10));

    expect(rateLimiter.tryOperation("player-1")).toBe(true);
  });

  it("correctly identifies when player is rate limited", () => {
    rateLimiter.tryOperation("player-1");

    // isAllowed should return false immediately after operation
    expect(rateLimiter.isAllowed("player-1")).toBe(false);

    // But a different player should not be rate limited
    expect(rateLimiter.isAllowed("player-2")).toBe(true);
  });
});

describe("Store Handler Integration - Input Validation", () => {
  describe("isValidItemId", () => {
    it("accepts valid item IDs", () => {
      expect(isValidItemId("bronze_shortsword")).toBe(true);
      expect(isValidItemId("coins")).toBe(true);
      expect(isValidItemId("rune_platebody")).toBe(true);
    });

    it("rejects invalid item IDs", () => {
      expect(isValidItemId("")).toBe(false);
      expect(isValidItemId(null)).toBe(false);
      expect(isValidItemId(undefined)).toBe(false);
      expect(isValidItemId(123)).toBe(false);
      expect(
        isValidItemId("a".repeat(INPUT_LIMITS.MAX_ITEM_ID_LENGTH + 1)),
      ).toBe(false);
    });

    it("rejects item IDs with control characters", () => {
      expect(isValidItemId("item\x00id")).toBe(false);
      expect(isValidItemId("item\nid")).toBe(false);
      expect(isValidItemId("item\rid")).toBe(false);
    });
  });

  describe("isValidStoreId", () => {
    it("accepts valid store IDs", () => {
      expect(isValidStoreId("town_general_store")).toBe(true);
      expect(isValidStoreId("varrock_sword_shop")).toBe(true);
    });

    it("rejects invalid store IDs", () => {
      expect(isValidStoreId("")).toBe(false);
      expect(isValidStoreId(null)).toBe(false);
      expect(
        isValidStoreId("a".repeat(INPUT_LIMITS.MAX_STORE_ID_LENGTH + 1)),
      ).toBe(false);
    });
  });

  describe("isValidQuantity", () => {
    it("accepts valid quantities", () => {
      expect(isValidQuantity(1)).toBe(true);
      expect(isValidQuantity(100)).toBe(true);
      expect(isValidQuantity(INPUT_LIMITS.MAX_QUANTITY)).toBe(true);
    });

    it("rejects invalid quantities", () => {
      expect(isValidQuantity(0)).toBe(false);
      expect(isValidQuantity(-1)).toBe(false);
      expect(isValidQuantity(1.5)).toBe(false);
      expect(isValidQuantity(NaN)).toBe(false);
      expect(isValidQuantity(Infinity)).toBe(false);
      expect(isValidQuantity(INPUT_LIMITS.MAX_QUANTITY + 1)).toBe(false);
    });
  });

  describe("wouldOverflow", () => {
    it("detects overflow correctly", () => {
      expect(wouldOverflow(INPUT_LIMITS.MAX_QUANTITY - 5, 10)).toBe(true);
      expect(wouldOverflow(INPUT_LIMITS.MAX_QUANTITY, 1)).toBe(true);
    });

    it("allows safe additions", () => {
      expect(wouldOverflow(0, 100)).toBe(false);
      expect(wouldOverflow(1000, 1000)).toBe(false);
      expect(wouldOverflow(INPUT_LIMITS.MAX_QUANTITY - 100, 100)).toBe(false);
    });
  });
});

describe("Store Handler Integration - Consistent Distance Algorithm", () => {
  it("store uses same distance as bank (Chebyshev, 2 tiles)", () => {
    // Both should use Chebyshev distance with 2 tile limit
    expect(INTERACTION_DISTANCE[SessionType.STORE]).toBe(2);
    expect(INTERACTION_DISTANCE[SessionType.BANK]).toBe(2);

    // At diagonal (2, 2): Chebyshev = 2, Euclidean = 2.83
    // Both systems should allow this
    const world: MockWorld = {
      entities: new Map([
        ["npc-1", { id: "npc-1", position: { x: 10, z: 10 } }],
      ]),
    };

    const socket: MockSocket = {
      id: "socket-1",
      player: { id: "player-1", position: { x: 12, y: 0, z: 12 } },
      storeSessionEntityId: "npc-1",
    };

    // Should pass because Chebyshev distance is 2
    expect(verifyStoreDistance(socket, world)).toBeNull();
  });
});
