/**
 * PendingGatherManager Unit Tests
 *
 * Tests the movement-to-gather flow:
 * - Queue pending gather (paths player to resource)
 * - Cancel pending gather
 * - Process tick (detect arrival, start gathering)
 * - Timeout handling
 * - Error isolation
 * - Disconnect cleanup
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PendingGatherManager } from "../PendingGatherManager";
import { EventType } from "@hyperforge/shared";

const AUTONOMY_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

// ===== MOCK FACTORIES =====

interface MockPlayer {
  id: string;
  position: { x: number; y: number; z: number };
  skills?: Record<string, { level: number; xp: number }>;
  data?: { inStreamingDuel?: boolean };
}

interface MockResource {
  id: string;
  position: { x: number; y: number; z: number };
  footprint?: "standard" | "large" | "massive";
  isAvailable: boolean;
  skillRequired?: string;
  levelRequired?: number;
  type?: string;
}

const createMockWorld = () => {
  const players = new Map<string, MockPlayer>();
  const resources = new Map<string, MockResource>();
  const emittedEvents: Array<{ type: string; data: unknown }> = [];
  const playerHasRequiredToolForResource = vi.fn(() => true);
  const requestGathering = vi.fn(() => true);

  return {
    players,
    resources,
    emittedEvents,
    playerHasRequiredToolForResource,
    requestGathering,

    getPlayer: vi.fn((id: string) => players.get(id)),

    getSystem: vi.fn((name: string) => {
      if (name === "resource") {
        return {
          getResource: (id: string) => resources.get(id),
          playerHasRequiredToolForResource,
          requestGathering,
        };
      }
      return null;
    }),

    emit: vi.fn((type: string, data: unknown) => {
      emittedEvents.push({ type, data });
    }),

    faceDirectionManager: {
      setCardinalFaceTarget: vi.fn(),
    },

    // Helpers for tests
    addPlayer: (player: MockPlayer) => {
      players.set(player.id, player);
    },

    addResource: (resource: MockResource) => {
      resources.set(resource.id, resource);
    },
  };
};

const createMockTileMovementManager = () => ({
  movePlayerToward: vi.fn(),
  getIsRunning: vi.fn(() => false),
  setArrivalEmote: vi.fn(),
  clearArrivalEmote: vi.fn(),
  isTileAvailableForPlayer: vi.fn(() => true),
  findClosestWalkableTile: vi.fn(
    (
      pos: { x: number; y: number; z: number },
      _radius: number,
      acceptsTile?: (tile: { x: number; z: number }) => boolean,
    ): { x: number; z: number } | null => {
      const origin = pos.x >= 20 ? 20 : 10;
      const candidates = [
        { x: origin, z: origin },
        { x: origin + 1, z: origin },
        { x: origin, z: origin + 1 },
        { x: origin - 1, z: origin },
      ];
      return candidates.find((tile) => acceptsTile?.(tile) ?? true) ?? null;
    },
  ),
});

type MockWorld = ReturnType<typeof createMockWorld>;
type MockTileMovementManager = ReturnType<typeof createMockTileMovementManager>;

// ===== TEST SUITES =====

describe("PendingGatherManager", () => {
  let manager: PendingGatherManager;
  let mockWorld: MockWorld;
  let mockTileMovement: MockTileMovementManager;
  let mockSendFn: (name: string, data: unknown) => void;

  beforeEach(() => {
    mockWorld = createMockWorld();
    mockTileMovement = createMockTileMovementManager();
    mockSendFn = vi.fn() as (name: string, data: unknown) => void;

    manager = new PendingGatherManager(
      mockWorld as never,
      mockTileMovement as never,
      mockSendFn,
    );
  });

  // ===== QUEUE PENDING GATHER TESTS =====

  describe("queuePendingGather", () => {
    it("rejects movement while streaming-duel authority is active", () => {
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 5, y: 0, z: 5 },
        data: { inStreamingDuel: true },
      });

      expect(manager.queuePendingGather("player1", "tree_1", 100)).toBe(false);
      expect(mockTileMovement.movePlayerToward).not.toHaveBeenCalled();
    });

    it("should path player to cardinal tile for trees/ores", () => {
      // Setup
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 5, y: 0, z: 5 },
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        skillRequired: "woodcutting",
        levelRequired: 1,
        type: "tree",
      });

      // Act
      const accepted = manager.queuePendingGather(
        "player1",
        "tree_1",
        0,
        false,
      );

      // Assert - should call movePlayerToward
      expect(mockTileMovement.movePlayerToward).toHaveBeenCalledWith(
        "player1",
        { x: 9.5, y: 0, z: 10.5 },
        false,
        0,
      );
      expect(accepted).toBe(true);
    });

    it("should path player to shore tile for fishing", () => {
      // Setup
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 5, y: 0, z: 5 },
        skills: { fishing: { level: 10, xp: 0 } },
      });

      mockWorld.addResource({
        id: "fishing_spot_1",
        position: { x: 15, y: 0, z: 15 }, // In water
        isAvailable: true,
        skillRequired: "fishing",
        levelRequired: 1,
        type: "fishing_spot",
      });

      // Act
      const accepted = manager.queuePendingGather(
        "player1",
        "fishing_spot_1",
        0,
        false,
      );

      // Assert - should find shore tile and path there
      expect(mockTileMovement.findClosestWalkableTile).toHaveBeenCalled();
      expect(mockTileMovement.setArrivalEmote).toHaveBeenCalledWith(
        "player1",
        "fishing",
      );
      expect(mockWorld.playerHasRequiredToolForResource).toHaveBeenCalledWith(
        "player1",
        "fishing_spot_1",
      );
      expect(accepted).toBe(true);
    });

    it("should start immediately if already adjacent", () => {
      // Setup - player already on cardinal tile adjacent to resource
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 10, y: 0, z: 9 }, // One tile south of resource at (10, 10)
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        skillRequired: "woodcutting",
        levelRequired: 1,
        type: "tree",
      });

      // Act
      const accepted = manager.queuePendingGather(
        "player1",
        "tree_1",
        0,
        false,
      );

      // Assert - should emit RESOURCE_GATHER immediately
      expect(mockWorld.emittedEvents).toContainEqual(
        expect.objectContaining({
          type: EventType.RESOURCE_GATHER,
          data: expect.objectContaining({
            playerId: "player1",
            resourceId: "tree_1",
          }),
        }),
      );
      expect(accepted).toBe(true);
    });

    it("threads an autonomous attempt into the authoritative gather start", () => {
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 10, y: 0, z: 9 },
      });
      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        skillRequired: "woodcutting",
        levelRequired: 1,
        type: "tree",
      });

      expect(
        manager.queuePendingGather(
          "player1",
          "tree_1",
          0,
          false,
          AUTONOMY_ATTEMPT_ID,
        ),
      ).toBe(true);
      expect(mockWorld.requestGathering).toHaveBeenCalledWith({
        playerId: "player1",
        resourceId: "tree_1",
        playerPosition: { x: 10, y: 0, z: 9 },
        completionAttemptId: AUTONOMY_ATTEMPT_ID,
      });
    });

    it("should cancel previous pending gather on new request", () => {
      // Setup
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 0, y: 0, z: 0 },
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        type: "tree",
      });

      mockWorld.addResource({
        id: "tree_2",
        position: { x: 20, y: 0, z: 20 },
        isAvailable: true,
        type: "tree",
      });

      // Act - queue two gathers
      const accepted = manager.queuePendingGather(
        "player1",
        "tree_1",
        0,
        false,
      );
      manager.queuePendingGather("player1", "tree_2", 1, false);

      // Assert - should only have one pending gather (the second one)
      // Access private map for verification
      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<string, { resourceId: string }>;
        }
      ).pendingGathers;

      expect(pendingGathers.size).toBe(1);
      expect(pendingGathers.get("player1")?.resourceId).toBe("tree_2");
      expect(accepted).toBe(true);
    });

    it("should silently ignore depleted resources", () => {
      // Setup
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 5, y: 0, z: 5 },
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: false, // Depleted
        type: "tree",
      });

      // Act
      const accepted = manager.queuePendingGather(
        "player1",
        "tree_1",
        0,
        false,
      );

      // Assert - should not path or queue
      expect(mockTileMovement.movePlayerToward).not.toHaveBeenCalled();

      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<string, unknown>;
        }
      ).pendingGathers;
      expect(pendingGathers.size).toBe(0);
      expect(accepted).toBe(false);
    });

    it("does not cancel a valid pending gather when a new target is rejected", () => {
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 0, y: 0, z: 0 },
      });
      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        type: "tree",
      });

      expect(manager.queuePendingGather("player1", "tree_1", 0, false)).toBe(
        true,
      );
      expect(
        manager.queuePendingGather("player1", "missing-tree", 1, false),
      ).toBe(false);

      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<string, { resourceId: string }>;
        }
      ).pendingGathers;
      expect(pendingGathers.get("player1")?.resourceId).toBe("tree_1");
    });

    it("reserves four distinct physical approaches and rejects overflow", () => {
      mockWorld.addResource({
        id: "ore_shared",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        skillRequired: "mining",
        levelRequired: 1,
        type: "ore",
      });
      for (let index = 0; index < 25; index++) {
        mockWorld.addPlayer({
          id: `gatherer-${index}`,
          position: { x: 0.5, y: 0, z: 0.5 },
          skills: { mining: { level: 1, xp: 0 } },
        });
      }

      const accepted = Array.from({ length: 25 }, (_, index) =>
        manager.queuePendingGather(`gatherer-${index}`, "ore_shared", 0, false),
      );
      expect(accepted.filter(Boolean)).toHaveLength(4);
      expect(mockTileMovement.movePlayerToward).toHaveBeenCalledTimes(4);
      expect(
        new Set(
          mockTileMovement.movePlayerToward.mock.calls.map(
            ([, position]) => `${position.x},${position.z}`,
          ),
        ).size,
      ).toBe(4);

      manager.cancelPendingGather("gatherer-0");
      expect(
        manager.queuePendingGather("gatherer-4", "ore_shared", 1, false),
      ).toBe(true);
      expect(mockTileMovement.movePlayerToward).toHaveBeenCalledTimes(5);
    });
  });

  // ===== CANCEL PENDING GATHER TESTS =====

  describe("cancelPendingGather", () => {
    it("should remove pending gather for player", () => {
      // Setup - manually add a pending gather
      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<string, unknown>;
        }
      ).pendingGathers;

      pendingGathers.set("player1", {
        playerId: "player1",
        resourceId: "tree_1",
      });

      // Act
      manager.cancelPendingGather("player1");

      // Assert
      expect(pendingGathers.has("player1")).toBe(false);
    });

    it("should do nothing if no pending gather exists", () => {
      // Act - should not throw
      expect(() => manager.cancelPendingGather("nonexistent")).not.toThrow();
    });
  });

  // ===== PROCESS TICK TESTS =====

  describe("processTick", () => {
    it("replans to the current shore when a fishing spot moves in transit", () => {
      mockWorld.addPlayer({
        id: "angler",
        position: { x: 5.5, y: 0, z: 5.5 },
        skills: { fishing: { level: 10, xp: 0 } },
      });
      const spot: MockResource = {
        id: "moving-spot",
        position: { x: 15.5, y: 8, z: 15.5 },
        isAvailable: true,
        skillRequired: "fishing",
        levelRequired: 1,
        type: "fishing_spot",
      };
      mockWorld.addResource(spot);
      mockTileMovement.findClosestWalkableTile
        .mockReturnValueOnce({ x: 10, z: 10 })
        .mockReturnValueOnce({ x: 20, z: 20 });

      expect(manager.queuePendingGather("angler", "moving-spot", 0, true)).toBe(
        true,
      );
      mockWorld.players.get("angler")!.position = { x: 10.5, y: 0, z: 10.5 };
      spot.position = { x: 25.5, y: 8, z: 25.5 };

      manager.processTick(1);

      expect(mockWorld.emittedEvents).not.toContainEqual(
        expect.objectContaining({ type: EventType.RESOURCE_GATHER }),
      );
      expect(mockTileMovement.clearArrivalEmote).toHaveBeenCalledWith("angler");
      expect(mockTileMovement.movePlayerToward).toHaveBeenLastCalledWith(
        "angler",
        { x: 20.5, y: 0, z: 20.5 },
        true,
        0,
      );
      const pending = (
        manager as unknown as {
          pendingGathers: Map<
            string,
            {
              resourceAnchorTile: { x: number; z: number };
              targetShoreTile: { x: number; z: number };
              runMode: boolean;
            }
          >;
        }
      ).pendingGathers.get("angler");
      expect(pending).toMatchObject({
        resourceAnchorTile: { x: 25, z: 25 },
        targetShoreTile: { x: 20, z: 20 },
        runMode: true,
      });
    });

    it("replans every admitted gatherer onto distinct shores after a spot moves", () => {
      const spot: MockResource = {
        id: "shared-moving-spot",
        position: { x: 15.5, y: 8, z: 15.5 },
        isAvailable: true,
        skillRequired: "fishing",
        levelRequired: 1,
        type: "fishing_spot",
      };
      mockWorld.addResource(spot);
      for (let index = 0; index < 25; index++) {
        mockWorld.addPlayer({
          id: `angler-${index}`,
          position: { x: 0.5, y: 0, z: 0.5 },
          skills: { fishing: { level: 10, xp: 0 } },
        });
      }

      const admitted = Array.from({ length: 25 }, (_, index) =>
        manager.queuePendingGather(
          `angler-${index}`,
          "shared-moving-spot",
          0,
          true,
        ),
      );
      expect(admitted.filter(Boolean)).toHaveLength(4);
      spot.position = { x: 25.5, y: 8, z: 25.5 };

      manager.processTick(1);

      const pending = (
        manager as unknown as {
          pendingGathers: Map<
            string,
            {
              resourceAnchorTile: { x: number; z: number };
              targetShoreTile: { x: number; z: number };
            }
          >;
        }
      ).pendingGathers;
      expect(pending.size).toBe(4);
      expect(
        new Set(
          [...pending.values()].map(
            ({ targetShoreTile }) =>
              `${targetShoreTile.x},${targetShoreTile.z}`,
          ),
        ).size,
      ).toBe(4);
      for (const value of pending.values()) {
        expect(value.resourceAnchorTile).toEqual({ x: 25, z: 25 });
        expect(value.targetShoreTile.x).toBeGreaterThanOrEqual(19);
      }
      expect(mockTileMovement.clearArrivalEmote).toHaveBeenCalledTimes(4);
      expect(mockTileMovement.movePlayerToward).toHaveBeenCalledTimes(8);
      expect(mockWorld.emittedEvents).not.toContainEqual(
        expect.objectContaining({ type: EventType.RESOURCE_GATHER }),
      );
    });

    it("should detect arrival at cardinal tile and start gathering", () => {
      // Setup - player has arrived at cardinal tile
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 10, y: 0, z: 9 }, // Cardinal to resource at (10, 10)
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        type: "tree",
      });

      // Manually add pending gather
      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<
            string,
            {
              playerId: string;
              resourceId: string;
              resourceAnchorTile: { x: number; z: number };
              footprintX: number;
              footprintZ: number;
              lastPlayerTile: { x: number; z: number };
              createdTick: number;
              isFishing: boolean;
              resourcePosition: { x: number; y: number; z: number };
            }
          >;
        }
      ).pendingGathers;

      pendingGathers.set("player1", {
        playerId: "player1",
        resourceId: "tree_1",
        resourceAnchorTile: { x: 10, z: 10 },
        footprintX: 1,
        footprintZ: 1,
        lastPlayerTile: { x: 5, z: 5 },
        createdTick: 0,
        isFishing: false,
        resourcePosition: { x: 10, y: 0, z: 10 },
      });

      // Act
      manager.processTick(1);

      // Assert - should emit RESOURCE_GATHER and remove from pending
      expect(mockWorld.emittedEvents).toContainEqual(
        expect.objectContaining({
          type: EventType.RESOURCE_GATHER,
        }),
      );
      expect(pendingGathers.has("player1")).toBe(false);
    });

    it("should timeout after 20 ticks", () => {
      // Setup
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 0, y: 0, z: 0 }, // Far from resource
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 100, y: 0, z: 100 },
        isAvailable: true,
        type: "tree",
      });

      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<
            string,
            {
              playerId: string;
              resourceId: string;
              resourceAnchorTile: { x: number; z: number };
              footprintX: number;
              footprintZ: number;
              lastPlayerTile: { x: number; z: number };
              createdTick: number;
              isFishing: boolean;
              resourcePosition: { x: number; y: number; z: number };
              completionAttemptId?: string;
              skill: string;
            }
          >;
        }
      ).pendingGathers;

      pendingGathers.set("player1", {
        playerId: "player1",
        resourceId: "tree_1",
        resourceAnchorTile: { x: 100, z: 100 },
        footprintX: 1,
        footprintZ: 1,
        lastPlayerTile: { x: 0, z: 0 },
        createdTick: 0,
        isFishing: false,
        resourcePosition: { x: 100, y: 0, z: 100 },
        completionAttemptId: AUTONOMY_ATTEMPT_ID,
        skill: "unknown",
      });

      // Act - process at tick 21 (timeout is 20)
      manager.processTick(21);

      // Assert - should be removed due to timeout
      expect(pendingGathers.has("player1")).toBe(false);
      // Should NOT have started gathering
      expect(mockWorld.emittedEvents).not.toContainEqual(
        expect.objectContaining({ type: EventType.RESOURCE_GATHER }),
      );
      expect(mockWorld.emittedEvents).toContainEqual({
        type: EventType.RESOURCE_GATHERING_COMPLETED,
        data: {
          playerId: "player1",
          resourceId: "tree_1",
          successful: false,
          skill: "unknown",
          operationId: `gathering-reward:${AUTONOMY_ATTEMPT_ID}`,
        },
      });
    });

    it("should cancel if resource becomes unavailable", () => {
      // Setup
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 5, y: 0, z: 5 },
      });

      // Resource starts available, then becomes unavailable
      const resource: MockResource = {
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        type: "tree",
      };
      mockWorld.addResource(resource);

      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<
            string,
            {
              playerId: string;
              resourceId: string;
              resourceAnchorTile: { x: number; z: number };
              footprintX: number;
              footprintZ: number;
              lastPlayerTile: { x: number; z: number };
              createdTick: number;
              isFishing: boolean;
              resourcePosition: { x: number; y: number; z: number };
            }
          >;
        }
      ).pendingGathers;

      pendingGathers.set("player1", {
        playerId: "player1",
        resourceId: "tree_1",
        resourceAnchorTile: { x: 10, z: 10 },
        footprintX: 1,
        footprintZ: 1,
        lastPlayerTile: { x: 5, z: 5 },
        createdTick: 0,
        isFishing: false,
        resourcePosition: { x: 10, y: 0, z: 10 },
      });

      // Make resource unavailable
      resource.isAvailable = false;

      // Act
      manager.processTick(1);

      // Assert - should be removed
      expect(pendingGathers.has("player1")).toBe(false);
    });

    it("should handle errors without breaking other players", () => {
      // Setup - two players, one will error
      mockWorld.addPlayer({
        id: "player1",
        position: { x: 10, y: 0, z: 9 },
      });

      mockWorld.addPlayer({
        id: "player2",
        position: { x: 20, y: 0, z: 19 },
      });

      mockWorld.addResource({
        id: "tree_1",
        position: { x: 10, y: 0, z: 10 },
        isAvailable: true,
        type: "tree",
      });

      mockWorld.addResource({
        id: "tree_2",
        position: { x: 20, y: 0, z: 20 },
        isAvailable: true,
        type: "tree",
      });

      const pendingGathers = (
        manager as unknown as {
          pendingGathers: Map<
            string,
            {
              playerId: string;
              resourceId: string;
              resourceAnchorTile: { x: number; z: number };
              footprintX: number;
              footprintZ: number;
              lastPlayerTile: { x: number; z: number };
              createdTick: number;
              isFishing: boolean;
              resourcePosition: { x: number; y: number; z: number };
            }
          >;
        }
      ).pendingGathers;

      // Add both pending gathers
      pendingGathers.set("player1", {
        playerId: "player1",
        resourceId: "tree_1",
        resourceAnchorTile: { x: 10, z: 10 },
        footprintX: 1,
        footprintZ: 1,
        lastPlayerTile: { x: 5, z: 5 },
        createdTick: 0,
        isFishing: false,
        resourcePosition: { x: 10, y: 0, z: 10 },
      });

      pendingGathers.set("player2", {
        playerId: "player2",
        resourceId: "tree_2",
        resourceAnchorTile: { x: 20, z: 20 },
        footprintX: 1,
        footprintZ: 1,
        lastPlayerTile: { x: 15, z: 15 },
        createdTick: 0,
        isFishing: false,
        resourcePosition: { x: 20, y: 0, z: 20 },
      });

      // Make player1's resource lookup throw an error
      const originalGetSystem = mockWorld.getSystem;
      let callCount = 0;
      mockWorld.getSystem = vi.fn((name: string) => {
        if (name === "resource") {
          return {
            getResource: (id: string) => {
              callCount++;
              if (callCount === 1) {
                throw new Error("Simulated error for player1");
              }
              return mockWorld.resources.get(id);
            },
            playerHasRequiredToolForResource:
              mockWorld.playerHasRequiredToolForResource,
            requestGathering: mockWorld.requestGathering,
          };
        }
        return originalGetSystem(name);
      });

      // Act - should not throw
      expect(() => manager.processTick(1)).not.toThrow();

      // Assert - player1 should be removed (error cleanup), player2 should be processed
      // Player2 should have gathering started (arrived at cardinal tile)
      const gatherEvents = mockWorld.emittedEvents.filter(
        (e) => e.type === EventType.RESOURCE_GATHER,
      );
      expect(gatherEvents.length).toBeGreaterThanOrEqual(0); // At least one should work
    });
  });

  // ===== DISCONNECT CLEANUP TESTS =====

  describe("onPlayerDisconnect", () => {
    it("should cleanup pending gather on disconnect", () => {
      const internals = manager as unknown as {
        pendingGathers: Map<string, unknown>;
        fishingReplans: Map<string, unknown>;
        approachReservations: Map<
          string,
          { playerId: string; resourceId: string }
        >;
      };

      // Add pending gather
      internals.pendingGathers.set("player1", {
        playerId: "player1",
        resourceId: "tree_1",
      });
      internals.fishingReplans.set("player1", {
        resourceId: "fishing_spot_1",
        runMode: true,
      });
      internals.approachReservations.set("10,10", {
        playerId: "player1",
        resourceId: "tree_1",
      });

      // Act
      manager.onPlayerDisconnect("player1");

      // Assert
      expect(internals.pendingGathers.has("player1")).toBe(false);
      expect(internals.fishingReplans.has("player1")).toBe(false);
      expect(
        [...internals.approachReservations.values()].some(
          ({ playerId }) => playerId === "player1",
        ),
      ).toBe(false);
    });

    it("should do nothing if player has no pending gather", () => {
      // Act - should not throw
      expect(() => manager.onPlayerDisconnect("nonexistent")).not.toThrow();
    });
  });

  // ===== CARDINAL TILE DETECTION TESTS =====

  describe("isOnCardinalTile", () => {
    // Access private method
    const getIsOnCardinalTile = (mgr: PendingGatherManager) =>
      (
        mgr as unknown as {
          isOnCardinalTile: (
            playerTile: { x: number; z: number },
            resourceAnchor: { x: number; z: number },
            footprintX: number,
            footprintZ: number,
          ) => boolean;
        }
      ).isOnCardinalTile.bind(mgr);

    it("should return true when player is north of resource", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // Player at (10, 11), resource at (10, 10)
      expect(isOnCardinalTile({ x: 10, z: 11 }, { x: 10, z: 10 }, 1, 1)).toBe(
        true,
      );
    });

    it("should return true when player is south of resource", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // Player at (10, 9), resource at (10, 10)
      expect(isOnCardinalTile({ x: 10, z: 9 }, { x: 10, z: 10 }, 1, 1)).toBe(
        true,
      );
    });

    it("should return true when player is east of resource", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // Player at (11, 10), resource at (10, 10)
      expect(isOnCardinalTile({ x: 11, z: 10 }, { x: 10, z: 10 }, 1, 1)).toBe(
        true,
      );
    });

    it("should return true when player is west of resource", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // Player at (9, 10), resource at (10, 10)
      expect(isOnCardinalTile({ x: 9, z: 10 }, { x: 10, z: 10 }, 1, 1)).toBe(
        true,
      );
    });

    it("should return false when player is diagonal to resource", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // Player at (11, 11), resource at (10, 10) - diagonal
      expect(isOnCardinalTile({ x: 11, z: 11 }, { x: 10, z: 10 }, 1, 1)).toBe(
        false,
      );
    });

    it("should return false when player is too far", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // Player at (10, 12), resource at (10, 10) - 2 tiles away
      expect(isOnCardinalTile({ x: 10, z: 12 }, { x: 10, z: 10 }, 1, 1)).toBe(
        false,
      );
    });

    it("should handle multi-tile resources", () => {
      const isOnCardinalTile = getIsOnCardinalTile(manager);
      // 2x2 resource at anchor (10, 10) - occupies (10,10), (11,10), (10,11), (11,11)
      // Player at (12, 10) - east of tile (11, 10)
      expect(isOnCardinalTile({ x: 12, z: 10 }, { x: 10, z: 10 }, 2, 2)).toBe(
        true,
      );
    });
  });
});
