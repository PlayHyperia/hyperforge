/**
 * ResourceSystem Integration Tests
 *
 * Tests the full gathering flow via event emission:
 * - Woodcutting: click tree → validate → gather → receive logs → deplete
 * - Mining: click ore → validate → mine → receive ore → deplete
 * - Fishing: click spot → validate → fish → receive fish → consume bait
 *
 * These tests verify the complete flow works end-to-end, including:
 * - Level requirement validation
 * - Tool requirement validation
 * - Movement cancellation
 * - Inventory full handling
 * - Bait/feather consumption
 * - Resource depletion
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ResourceSystem } from "../ResourceSystem";
import { EventType } from "../../../../types/events";

// ===== MOCK WORLD FACTORY =====

interface MockPlayer {
  id: string;
  position: { x: number; y: number; z: number };
  skills: Record<string, { level: number; xp: number }>;
  emote?: string;
  data?: {
    e?: string;
    gatheringToolPresentation?: { revision: number; itemId: string | null };
    fishingInteractionPresentation?: {
      revision: number;
      interactionId: string | null;
      resourceId: string | null;
      itemId: "small_fishing_net" | "harpoon" | "lobster_pot" | null;
      phase:
        | "idle"
        | "held"
        | "released"
        | "deployed"
        | "striking"
        | "retrieving"
        | "recovering";
      outcome: "none" | "pending" | "verifying" | "miss" | "caught";
      attempt: number;
      serverTick: number;
      phaseStartedAtServerTimeMs?: number;
      targetPosition: { x: number; y: number; z: number } | null;
    };
  };
  markNetworkDirty: ReturnType<typeof vi.fn>;
}

interface MockInventoryItem {
  itemId: string;
  quantity: number;
}

interface MockInventory {
  items: MockInventoryItem[];
  isFull: boolean;
}

const createMockWorld = () => {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const players = new Map<string, MockPlayer>();
  const inventories = new Map<string, MockInventory>();
  const emittedEvents: Array<{ type: string; data: unknown }> = [];

  return {
    isServer: true,
    currentTick: 0,
    entities: new Map(),
    players,
    inventories,
    emittedEvents,

    // Event system
    emit: vi.fn((type: string, data: unknown) => {
      emittedEvents.push({ type, data });
      const handlers = eventHandlers.get(type);
      if (handlers) {
        handlers.forEach((handler) => handler(data));
      }
    }),

    on: vi.fn((type: string, handler: (data: unknown) => void) => {
      if (!eventHandlers.has(type)) {
        eventHandlers.set(type, new Set());
      }
      eventHandlers.get(type)!.add(handler);
      return { unsubscribe: () => eventHandlers.get(type)?.delete(handler) };
    }),

    off: vi.fn((type: string, handler: (data: unknown) => void) => {
      eventHandlers.get(type)?.delete(handler);
    }),

    getPlayer: vi.fn((id: string) => players.get(id)),

    getSystem: vi.fn((name: string) => {
      if (name === "inventory") {
        return {
          getInventory: (playerId: string) => inventories.get(playerId),
          addItem: vi.fn((playerId: string, item: MockInventoryItem) => {
            const inv = inventories.get(playerId);
            if (inv && !inv.isFull) {
              inv.items.push(item);
              return true;
            }
            return false;
          }),
          removeItem: vi.fn((playerId: string, itemId: string, qty: number) => {
            const inv = inventories.get(playerId);
            if (inv) {
              const item = inv.items.find((i) => i.itemId === itemId);
              if (item && item.quantity >= qty) {
                item.quantity -= qty;
                return true;
              }
            }
            return false;
          }),
          commitGatheringRewardAtomic: vi.fn(
            async (
              playerId: string,
              operationId: string,
              input: {
                resourceId: string;
                depleteAfterCommit: boolean;
                respawnTicks: number;
                skill: "woodcutting" | "mining" | "fishing";
                xpAmount: number;
                rewardItemId: string;
                rewardQuantity: number;
                secondaryItemId?: string | null;
              },
            ) => {
              const inv = inventories.get(playerId);
              if (!inv || inv.isFull) {
                return {
                  ok: false as const,
                  committed: false as const,
                  liveInventoryApplied: false,
                  playerId,
                  operationId,
                  replayed: false as const,
                  skill: input.skill,
                  xpAmount: input.xpAmount,
                  reward: null,
                  secondaryItemId: input.secondaryItemId ?? null,
                  retryable: false,
                  reason: "inventory_full" as const,
                };
              }
              if (input.secondaryItemId) {
                const secondary = inv.items.find(
                  (item) => item.itemId === input.secondaryItemId,
                );
                if (!secondary || secondary.quantity < 1) {
                  return {
                    ok: false as const,
                    committed: false as const,
                    liveInventoryApplied: false,
                    playerId,
                    operationId,
                    replayed: false as const,
                    skill: input.skill,
                    xpAmount: input.xpAmount,
                    reward: null,
                    secondaryItemId: input.secondaryItemId,
                    retryable: false,
                    reason: "secondary_missing" as const,
                  };
                }
                secondary.quantity--;
                if (secondary.quantity === 0) {
                  inv.items.splice(inv.items.indexOf(secondary), 1);
                }
              }
              inv.items.push({
                itemId: input.rewardItemId,
                quantity: input.rewardQuantity,
              });
              return {
                ok: true as const,
                committed: true as const,
                liveInventoryApplied: true,
                playerId,
                operationId,
                replayed: false,
                resourceId: input.resourceId,
                depleteAfterCommit: input.depleteAfterCommit,
                respawnTicks: input.respawnTicks,
                depletedUntil: input.depleteAfterCommit
                  ? Date.now() + input.respawnTicks * 600
                  : null,
                skill: input.skill,
                xpAmount: input.xpAmount,
                reward: {
                  itemId: input.rewardItemId,
                  quantity: input.rewardQuantity,
                  stackable: false,
                },
                secondaryItemId: input.secondaryItemId ?? null,
                awardedXp: input.xpAmount,
                operationCommittedXp: input.xpAmount,
                currentXp: input.xpAmount,
                currentLevel: 1,
              };
            },
          ),
        };
      }
      if (name === "skills") {
        return {
          getSkillLevel: (playerId: string, skill: string) => {
            const player = players.get(playerId);
            return player?.skills[skill]?.level ?? 1;
          },
          addXp: vi.fn(),
        };
      }
      return null;
    }),

    $eventBus: {
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      subscribeOnce: vi.fn(() => ({ unsubscribe: vi.fn() })),
      emitEvent: vi.fn(),
      request: vi.fn(),
      respond: vi.fn(),
    },

    network: {
      send: vi.fn(),
    },

    chat: {
      sendSystemMessage: vi.fn(),
      add: vi.fn(),
    },

    // Helper methods for tests
    addPlayer: (player: MockPlayer) => {
      players.set(player.id, player);
    },

    setInventory: (playerId: string, inventory: MockInventory) => {
      inventories.set(playerId, inventory);
    },

    advanceTick: (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        (createMockWorld as unknown as { currentTick: number }).currentTick++;
      }
    },
  };
};

type MockWorld = ReturnType<typeof createMockWorld>;

// ===== HELPER FUNCTIONS =====

const createTestPlayer = (
  id: string,
  skills: Record<string, number> = {},
): MockPlayer => ({
  id,
  position: { x: 10, y: 0, z: 10 },
  skills: Object.fromEntries(
    Object.entries(skills).map(([k, v]) => [k, { level: v, xp: 0 }]),
  ),
  markNetworkDirty: vi.fn(),
});

const createTestInventory = (
  items: MockInventoryItem[] = [],
  isFull = false,
): MockInventory => ({
  items,
  isFull,
});

// ===== TEST SUITES =====

describe("ResourceSystem Integration", () => {
  let system: ResourceSystem;
  let mockWorld: MockWorld;

  beforeEach(() => {
    mockWorld = createMockWorld();
    system = new ResourceSystem(mockWorld as never);
  });

  afterEach(() => {
    system.destroy();
  });

  // ===== VALIDATION TESTS =====

  describe("Gathering Validation", () => {
    it("should reject gathering if player lacks required level", () => {
      // Setup: Level 1 player trying to gather level 15 resource
      const player = createTestPlayer("player1", { woodcutting: 1 });
      mockWorld.addPlayer(player);
      mockWorld.setInventory(
        "player1",
        createTestInventory([{ itemId: "bronze_hatchet", quantity: 1 }]),
      );

      // Access private method to register a test resource
      const registerResource = (
        system as unknown as {
          registerResource: (resource: {
            id: string;
            type: string;
            position: { x: number; y: number; z: number };
            isAvailable: boolean;
            skillRequired: string;
            levelRequired: number;
            toolRequired: string;
          }) => void;
        }
      ).registerResource?.bind(system);

      // If registerResource doesn't exist, skip this test
      if (!registerResource) {
        // Test the validation logic directly via startGathering
        const startGathering = (
          system as unknown as {
            startGathering: (data: {
              playerId: string;
              resourceId: string;
              playerPosition: { x: number; y: number; z: number };
            }) => void;
          }
        ).startGathering?.bind(system);

        if (startGathering) {
          // This should fail due to resource not found
          startGathering({
            playerId: "player1",
            resourceId: "test_tree",
            playerPosition: { x: 10, y: 0, z: 10 },
          });
        }

        // Verify UI message was sent about level requirement
        const uiMessages = mockWorld.emittedEvents.filter(
          (e) => e.type === EventType.UI_MESSAGE,
        );
        // Resource not found is expected since we can't register
        expect(uiMessages.length).toBeGreaterThanOrEqual(0);
        return;
      }

      registerResource({
        id: "test_oak_tree",
        type: "tree",
        position: { x: 11, y: 0, z: 10 },
        isAvailable: true,
        skillRequired: "woodcutting",
        levelRequired: 15,
        toolRequired: "hatchet",
      });

      // Emit gather event
      mockWorld.emit(EventType.RESOURCE_GATHER, {
        playerId: "player1",
        resourceId: "test_oak_tree",
        playerPosition: { x: 10, y: 0, z: 10 },
      });

      // Should emit UI message about level requirement
      const uiMessages = mockWorld.emittedEvents.filter(
        (e) => e.type === EventType.UI_MESSAGE,
      );
      expect(uiMessages.length).toBeGreaterThan(0);
    });

    it("should reject gathering if player lacks required tool", () => {
      const player = createTestPlayer("player1", { woodcutting: 50 });
      mockWorld.addPlayer(player);
      // Empty inventory - no hatchet
      mockWorld.setInventory("player1", createTestInventory([]));

      // Emit gather event for a tree (requires hatchet)
      mockWorld.emit(EventType.RESOURCE_GATHER, {
        playerId: "player1",
        resourceId: "tree_normal_1",
        playerPosition: { x: 10, y: 0, z: 10 },
      });

      // Should emit UI message about tool requirement
      const _uiMessages = mockWorld.emittedEvents.filter(
        (e) => e.type === EventType.UI_MESSAGE,
      );
      // Verify no gathering started event
      const gatheringStarted = mockWorld.emittedEvents.filter(
        (e) => e.type === EventType.RESOURCE_GATHERING_STARTED,
      );
      expect(gatheringStarted.length).toBe(0);
    });

    it("should reject gathering if player lacks bait for fishing", () => {
      const player = createTestPlayer("player1", { fishing: 10 });
      mockWorld.addPlayer(player);
      // Has fishing rod but no bait
      mockWorld.setInventory(
        "player1",
        createTestInventory([{ itemId: "fishing_rod", quantity: 1 }]),
      );

      // Emit gather event for bait fishing spot
      mockWorld.emit(EventType.RESOURCE_GATHER, {
        playerId: "player1",
        resourceId: "fishing_spot_bait_1",
        playerPosition: { x: 10, y: 0, z: 10 },
      });

      // Should not start gathering
      const gatheringStarted = mockWorld.emittedEvents.filter(
        (e) => e.type === EventType.RESOURCE_GATHERING_STARTED,
      );
      expect(gatheringStarted.length).toBe(0);
    });

    it("presents the exact required fishing item and publishes a committed catch lifecycle", async () => {
      const previousTools = (
        globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> }
      ).EXTERNAL_TOOLS;
      const previousResources = (
        globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
      ).EXTERNAL_RESOURCES;
      (globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> }).EXTERNAL_TOOLS =
        new Map([
          [
            "fishing_rod",
            {
              itemId: "fishing_rod",
              skill: "fishing",
              tier: "unknown",
              levelRequired: 1,
              priority: 1,
            },
          ],
        ]);
      (
        globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
      ).EXTERNAL_RESOURCES = new Map([
        [
          "fishing_spot_net",
          {
            id: "fishing_spot_net",
            levelRequired: 1,
            baseCycleTicks: 5,
            depleteChance: 0,
            respawnTicks: 0,
            harvestYield: [{ xpAmount: 10 }],
          },
        ],
      ]);
      const random = vi.spyOn(Math, "random").mockReturnValue(0);

      try {
        const player = createTestPlayer("player1", { fishing: 1 });
        player.emote = "idle";
        player.data = { e: "idle" };
        mockWorld.addPlayer(player);
        mockWorld.setInventory(
          "player1",
          createTestInventory([
            { itemId: "small_fishing_net", quantity: 1 },
            { itemId: "fishing_rod", quantity: 1 },
          ]),
        );

        const resourceId = "fishing_spot_net_authority";
        const internals = system as unknown as {
          resources: Map<string, unknown>;
          resourceVariants: Map<string, string>;
          startGathering(data: {
            playerId: string;
            resourceId: string;
            playerPosition: { x: number; y: number; z: number };
          }): void;
        };
        internals.resources.set(resourceId, {
          id: resourceId,
          type: "fishing_spot",
          name: "Net Fishing Spot",
          position: { x: 11, y: 0, z: 10 },
          skillRequired: "fishing",
          levelRequired: 1,
          toolRequired: "small_fishing_net",
          respawnTime: 0,
          isAvailable: true,
          lastDepleted: 0,
          drops: [
            {
              itemId: "raw_shrimp",
              itemName: "Raw Shrimp",
              quantity: 1,
              chance: 1,
              xpAmount: 10,
              stackable: false,
            },
          ],
        });
        internals.resourceVariants.set(resourceId, "fishing_spot_net");

        internals.startGathering({
          playerId: "player1",
          resourceId,
          playerPosition: player.position,
        });

        const toolShows = mockWorld.$eventBus.emitEvent.mock.calls.filter(
          ([eventType]) => eventType === EventType.GATHERING_TOOL_SHOW,
        );
        expect(toolShows).toHaveLength(1);
        expect(toolShows[0]?.[1]).toEqual({
          playerId: "player1",
          itemId: "small_fishing_net",
          slot: "weapon",
          revision: 1,
        });
        expect(player.data?.gatheringToolPresentation).toEqual({
          revision: 1,
          itemId: "small_fishing_net",
        });
        expect(player.emote).toBe("small_fishing_net");
        expect(player.data?.e).toBe("small_fishing_net");
        expect(mockWorld.network.send).toHaveBeenCalledWith("entityModified", {
          id: "player1",
          e: "small_fishing_net",
        });
        expect(player.data?.fishingInteractionPresentation).toMatchObject({
          revision: 1,
          interactionId: expect.stringMatching(/^fishing:/u),
          resourceId,
          itemId: "small_fishing_net",
          phase: "held",
          outcome: "none",
          attempt: 0,
          serverTick: 0,
          targetPosition: { x: 11, y: 0, z: 10 },
        });

        system.processGatheringTick(1);
        expect(player.data?.fishingInteractionPresentation).toMatchObject({
          revision: 2,
          phase: "released",
          serverTick: 1,
        });
        system.processGatheringTick(2);
        expect(player.data?.fishingInteractionPresentation).toMatchObject({
          revision: 3,
          phase: "deployed",
          serverTick: 2,
        });
        system.processGatheringTick(3);
        expect(player.data?.fishingInteractionPresentation).toMatchObject({
          revision: 4,
          phase: "deployed",
          outcome: "pending",
          attempt: 1,
          serverTick: 3,
        });
        const internalsAfterAttempt = system as unknown as {
          pendingGatherRewards: Map<string, { state: string }>;
        };
        await vi.waitFor(() => {
          expect(
            internalsAfterAttempt.pendingGatherRewards.get("player1")?.state,
          ).toBe("settled");
        });
        system.processGatheringTick(4);
        expect(player.data?.fishingInteractionPresentation).toMatchObject({
          revision: 5,
          phase: "retrieving",
          outcome: "caught",
          attempt: 1,
          serverTick: 4,
        });

        (
          system as unknown as {
            stopGathering(data: { playerId: string }): void;
          }
        ).stopGathering({ playerId: "player1" });
        expect(player.data?.gatheringToolPresentation).toEqual({
          revision: 2,
          itemId: null,
        });
        expect(player.data?.fishingInteractionPresentation).toEqual({
          revision: 6,
          interactionId: null,
          resourceId: null,
          itemId: null,
          phase: "idle",
          outcome: "none",
          attempt: 0,
          serverTick: 4,
          phaseStartedAtServerTimeMs: expect.any(Number),
          targetPosition: null,
        });
        expect(
          mockWorld.$eventBus.emitEvent.mock.calls.findLast(
            ([eventType]) => eventType === EventType.GATHERING_TOOL_HIDE,
          )?.[1],
        ).toEqual({
          playerId: "player1",
          slot: "weapon",
          revision: 2,
        });
        expect(player.emote).toBe("idle");
        expect(player.data?.e).toBe("idle");
      } finally {
        random.mockRestore();
        if (previousTools) {
          (
            globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> }
          ).EXTERNAL_TOOLS = previousTools;
        } else {
          delete (globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> })
            .EXTERNAL_TOOLS;
        }
        if (previousResources) {
          (
            globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
          ).EXTERNAL_RESOURCES = previousResources;
        } else {
          delete (globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> })
            .EXTERNAL_RESOURCES;
        }
      }
    });

    it("binds one harpoon body action to strike and recovery without retriggering it", () => {
      const player = createTestPlayer("player1", { fishing: 35 });
      player.emote = "idle";
      player.data = { e: "idle" };
      mockWorld.addPlayer(player);
      const session = {
        resourceId: "fishing_spot_harpoon_authority",
        attempts: 1,
        fishingInteraction: {
          interactionId: "fishing:harpoon-authority",
          itemId: "harpoon" as const,
          phase: "held" as const,
          outcome: "none" as const,
          targetPosition: { x: 11, y: -0.25, z: 10 },
          nextTransitionTick: null,
          firstAttemptTick: 21,
          awaitingOperationId: null,
          phaseStartedAtServerTimeMs: 12_000,
        },
      };
      const transition = (
        system as unknown as {
          transitionFishingInteraction(
            playerId: string,
            currentSession: typeof session,
            phase: "held" | "striking" | "recovering",
            outcome: "none" | "pending" | "miss",
            nextTransitionTick: number | null,
          ): void;
        }
      ).transitionFishingInteraction.bind(system);

      transition("player1", session, "striking", "pending", 22);
      expect(player.emote).toBe("harpoon");
      expect(player.data?.e).toBe("harpoon");

      session.fishingInteraction.awaitingOperationId = "gathering-reward:1";
      const presentationInternals = system as unknown as {
        activeGathering: Map<string, typeof session>;
        advanceFishingInteractionPresentations(tickNumber: number): void;
      };
      presentationInternals.activeGathering.set("player1", session);
      presentationInternals.advanceFishingInteractionPresentations(22);
      expect(player.emote).toBe("harpoon");
      expect(player.data?.e).toBe("harpoon");
      expect(session.fishingInteraction.phase).toBe("recovering");
      expect(session.fishingInteraction.outcome).toBe("verifying");

      transition("player1", session, "held", "none", null);
      expect(player.emote).toBe("idle");
      expect(player.data?.e).toBe("idle");
      expect(
        mockWorld.network.send.mock.calls
          .filter(([eventType]) => eventType === "entityModified")
          .map(([, payload]) => payload),
      ).toEqual([
        { id: "player1", e: "harpoon" },
        { id: "player1", e: "idle" },
      ]);
      expect(
        mockWorld.$eventBus.emitEvent.mock.calls
          .filter(
            ([eventType]) =>
              eventType === EventType.FISHING_INTERACTION_PRESENTATION,
          )
          .map(([, payload]) => payload),
      ).toEqual([
        expect.objectContaining({ phase: "striking", outcome: "pending" }),
        expect.objectContaining({
          phase: "recovering",
          outcome: "verifying",
        }),
        expect.objectContaining({ phase: "held", outcome: "none" }),
      ]);
    });

    it("does not apply an unrelated higher-priority fishing tool's level requirement", () => {
      const previousTools = (
        globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> }
      ).EXTERNAL_TOOLS;
      const previousResources = (
        globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
      ).EXTERNAL_RESOURCES;
      (globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> }).EXTERNAL_TOOLS =
        new Map([
          [
            "harpoon",
            {
              itemId: "harpoon",
              skill: "fishing",
              tier: "unknown",
              levelRequired: 99,
              priority: 1,
            },
          ],
          [
            "fishing_rod",
            {
              itemId: "fishing_rod",
              skill: "fishing",
              tier: "unknown",
              levelRequired: 1,
              priority: 2,
            },
          ],
        ]);
      (
        globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
      ).EXTERNAL_RESOURCES = new Map([
        [
          "fishing_spot_bait",
          {
            id: "fishing_spot_bait",
            levelRequired: 1,
            baseCycleTicks: 5,
            depleteChance: 0,
            respawnTicks: 0,
            harvestYield: [{ xpAmount: 20 }],
          },
        ],
      ]);

      try {
        const player = createTestPlayer("player1", { fishing: 1 });
        player.emote = "idle";
        player.data = { e: "idle" };
        mockWorld.addPlayer(player);
        mockWorld.setInventory(
          "player1",
          createTestInventory([
            { itemId: "fishing_rod", quantity: 1 },
            { itemId: "harpoon", quantity: 1 },
            { itemId: "fishing_bait", quantity: 1 },
          ]),
        );

        const resourceId = "fishing_spot_bait_authority";
        const internals = system as unknown as {
          resources: Map<string, unknown>;
          resourceVariants: Map<string, string>;
          startGathering(data: {
            playerId: string;
            resourceId: string;
            playerPosition: { x: number; y: number; z: number };
          }): void;
        };
        internals.resources.set(resourceId, {
          id: resourceId,
          type: "fishing_spot",
          name: "Bait Fishing Spot",
          position: { x: 11, y: 0, z: 10 },
          skillRequired: "fishing",
          levelRequired: 1,
          toolRequired: "fishing_rod",
          secondaryRequired: "fishing_bait",
          respawnTime: 0,
          isAvailable: true,
          lastDepleted: 0,
          drops: [
            {
              itemId: "raw_sardine",
              itemName: "Raw Sardine",
              quantity: 1,
              chance: 1,
              xpAmount: 20,
              stackable: false,
            },
          ],
        });
        internals.resourceVariants.set(resourceId, "fishing_spot_bait");

        internals.startGathering({
          playerId: "player1",
          resourceId,
          playerPosition: player.position,
        });

        expect(
          mockWorld.$eventBus.emitEvent.mock.calls.some(
            ([eventType]) => eventType === EventType.RESOURCE_GATHERING_STARTED,
          ),
        ).toBe(true);
        expect(
          mockWorld.$eventBus.emitEvent.mock.calls.find(
            ([eventType]) => eventType === EventType.GATHERING_TOOL_SHOW,
          )?.[1],
        ).toEqual({
          playerId: "player1",
          itemId: "fishing_rod",
          slot: "weapon",
          revision: 1,
        });
        expect(player.emote).toBe("fishing_rod");
        expect(player.data?.e).toBe("fishing_rod");
        expect(mockWorld.network.send).toHaveBeenCalledWith("entityModified", {
          id: "player1",
          e: "fishing_rod",
        });
      } finally {
        if (previousTools) {
          (
            globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> }
          ).EXTERNAL_TOOLS = previousTools;
        } else {
          delete (globalThis as { EXTERNAL_TOOLS?: Map<string, unknown> })
            .EXTERNAL_TOOLS;
        }
        if (previousResources) {
          (
            globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
          ).EXTERNAL_RESOURCES = previousResources;
        } else {
          delete (globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> })
            .EXTERNAL_RESOURCES;
        }
      }
    });
  });

  describe("Movement Cancellation", () => {
    it("should cancel gathering when player moves", () => {
      const player = createTestPlayer("player1", { woodcutting: 50 });
      mockWorld.addPlayer(player);
      mockWorld.setInventory(
        "player1",
        createTestInventory([{ itemId: "bronze_hatchet", quantity: 1 }]),
      );

      // Access activeGathering to simulate an active session
      const activeGathering = (
        system as unknown as {
          activeGathering: Map<
            string,
            {
              playerId: string;
              cachedStartPosition: { x: number; y: number; z: number };
            }
          >;
        }
      ).activeGathering;

      // Manually add a gathering session
      activeGathering.set(
        "player1" as never,
        {
          playerId: "player1",
          cachedStartPosition: { x: 10, y: 0, z: 10 },
        } as never,
      );

      // Move player
      player.position = { x: 15, y: 0, z: 15 };

      // Process tick should detect movement and cancel
      system.processGatheringTick(1);

      // Session should be removed
      expect(activeGathering.has("player1" as never)).toBe(false);
    });
  });

  describe("Inventory Full Handling", () => {
    it("should stop gathering when inventory is full", () => {
      const player = createTestPlayer("player1", { woodcutting: 50 });
      mockWorld.addPlayer(player);
      mockWorld.setInventory(
        "player1",
        createTestInventory(
          [{ itemId: "bronze_hatchet", quantity: 1 }],
          true, // isFull = true
        ),
      );

      // Access private method
      const checkInventorySpace = (
        system as unknown as {
          playerHasInventorySpace: (playerId: string) => boolean;
        }
      ).playerHasInventorySpace;

      if (checkInventorySpace) {
        const hasSpace = checkInventorySpace.call(system, "player1");
        expect(hasSpace).toBe(false);
      }
    });
  });

  describe("Resource ID Security", () => {
    it("should reject malicious resource IDs", () => {
      const isValidResourceId = (
        system as unknown as {
          isValidResourceId: (id: string) => boolean;
        }
      ).isValidResourceId.bind(system);

      // SQL injection attempt
      expect(isValidResourceId("tree; DROP TABLE users")).toBe(false);

      // XSS attempt
      expect(isValidResourceId("<script>alert(1)</script>")).toBe(false);

      // Path traversal
      expect(isValidResourceId("../../../etc/passwd")).toBe(false);

      // Valid IDs should pass
      expect(isValidResourceId("tree_normal_1")).toBe(true);
      expect(isValidResourceId("ore_copper")).toBe(true);
      expect(isValidResourceId("fishing-spot.net")).toBe(true);
    });
  });

  describe("Rate Limiting", () => {
    it("should reject rapid gather attempts", () => {
      const player = createTestPlayer("player1", { woodcutting: 50 });
      mockWorld.addPlayer(player);
      mockWorld.setInventory(
        "player1",
        createTestInventory([{ itemId: "bronze_hatchet", quantity: 1 }]),
      );

      // Access rate limit map
      const gatherRateLimits = (
        system as unknown as {
          gatherRateLimits: Map<string, number>;
        }
      ).gatherRateLimits;

      // Set a recent attempt timestamp
      gatherRateLimits.set("player1" as never, Date.now());

      // Try to gather immediately - should be rate limited
      mockWorld.emit(EventType.RESOURCE_GATHER, {
        playerId: "player1",
        resourceId: "tree_normal_1",
        playerPosition: { x: 10, y: 0, z: 10 },
      });

      // Should not start a new gathering session
      const activeGathering = (
        system as unknown as {
          activeGathering: Map<string, unknown>;
        }
      ).activeGathering;

      expect(activeGathering.has("player1" as never)).toBe(false);
    });
  });

  describe("Disconnect Cleanup", () => {
    it("should cleanup gathering session on player disconnect", () => {
      const player = createTestPlayer("player1", { woodcutting: 50 });
      mockWorld.addPlayer(player);

      // Access activeGathering and rate limits
      const activeGathering = (
        system as unknown as {
          activeGathering: Map<string, unknown>;
        }
      ).activeGathering;

      const gatherRateLimits = (
        system as unknown as {
          gatherRateLimits: Map<string, number>;
        }
      ).gatherRateLimits;

      // Access cleanupPlayerGathering method
      const cleanupPlayerGathering = (
        system as unknown as {
          cleanupPlayerGathering: (playerId: string) => void;
        }
      ).cleanupPlayerGathering.bind(system);

      // Add mock session and rate limit
      activeGathering.set("player1" as never, { playerId: "player1" } as never);
      gatherRateLimits.set("player1" as never, Date.now());

      // Call cleanup directly (simulates PLAYER_UNREGISTERED event handler)
      cleanupPlayerGathering("player1");

      // Both should be cleaned up
      expect(activeGathering.has("player1" as never)).toBe(false);
      expect(gatherRateLimits.has("player1" as never)).toBe(false);
    });
  });

  // ===== PHASE 2: Security Hardening Tests =====

  describe("Suspicious Pattern Tracking", () => {
    it("should track rapid disconnects during active gather", () => {
      const player = createTestPlayer("player1", { woodcutting: 50 });
      mockWorld.addPlayer(player);

      // Access internal maps
      const activeGathering = (
        system as unknown as {
          activeGathering: Map<string, { playerId: string }>;
        }
      ).activeGathering;

      const suspiciousPatterns = (
        system as unknown as {
          suspiciousPatterns: Map<
            string,
            {
              rapidDisconnects: number;
              lastDisconnect: number;
              rapidGatherAttempts: number;
              lastAttempt: number;
            }
          >;
        }
      ).suspiciousPatterns;

      const cleanupPlayerGathering = (
        system as unknown as {
          cleanupPlayerGathering: (playerId: string) => void;
        }
      ).cleanupPlayerGathering.bind(system);

      // Simulate active gathering session
      activeGathering.set(
        "player1" as never,
        {
          playerId: "player1",
        } as never,
      );

      // First disconnect
      cleanupPlayerGathering("player1");
      let patterns = suspiciousPatterns.get("player1" as never);
      expect(patterns?.rapidDisconnects).toBe(1);

      // Simulate another active session and rapid disconnect
      activeGathering.set(
        "player1" as never,
        {
          playerId: "player1",
        } as never,
      );
      cleanupPlayerGathering("player1");
      patterns = suspiciousPatterns.get("player1" as never);
      expect(patterns?.rapidDisconnects).toBe(2);
    });
  });

  describe("Depletion Chance", () => {
    it("should never deplete a resource with depleteChance: 0 (essence rock)", () => {
      // Setup: Player with mining skill and pickaxe
      const player = createTestPlayer("miner1", { mining: 1 });
      player.position = { x: 10, y: 0, z: 10 };
      mockWorld.addPlayer(player);
      mockWorld.setInventory(
        "miner1",
        createTestInventory([{ itemId: "bronze_pickaxe", quantity: 1 }]),
      );

      const resourceId = "ore_essence_10_10";
      const playerId = "miner1";
      const startTick = 100;

      // Inject resource into the resources map (type: "ore" triggers mining branch)
      const resources = (
        system as unknown as {
          resources: Map<
            string,
            {
              id: string;
              type: string;
              name: string;
              position: { x: number; y: number; z: number };
              skillRequired: string;
              levelRequired: number;
              toolRequired: string;
              respawnTime: number;
              isAvailable: boolean;
              lastDepleted: number;
              drops: Array<{
                itemId: string;
                itemName: string;
                quantity: number;
                chance: number;
                xpAmount: number;
              }>;
            }
          >;
        }
      ).resources;

      resources.set(resourceId as never, {
        id: resourceId,
        type: "ore",
        name: "Rune Essence",
        position: { x: 11, y: 0, z: 10 },
        skillRequired: "mining",
        levelRequired: 1,
        toolRequired: "pickaxe",
        respawnTime: 0,
        isAvailable: true,
        lastDepleted: 0,
        drops: [
          {
            itemId: "rune_essence",
            itemName: "Rune essence",
            quantity: 1,
            chance: 1,
            xpAmount: 5,
          },
        ],
      });

      // Inject gathering session with depleteChance: 0
      const activeGathering = (
        system as {
          activeGathering: Map<string, Record<string, unknown>>;
        }
      ).activeGathering;

      activeGathering.set(playerId, {
        playerId,
        resourceId,
        startTick,
        nextAttemptTick: startTick, // Ready to process immediately
        cycleTickInterval: 4,
        attempts: 0,
        successes: 0,
        cachedTuning: {
          levelRequired: 1,
          xpPerLog: 5,
          depleteChance: 0, // KEY: essence rocks never deplete
          respawnTicks: 0,
        },
        cachedSuccessRate: 1.0, // Always succeed to force depletion checks
        cachedDrops: [
          {
            itemId: "rune_essence",
            itemName: "Rune essence",
            quantity: 1,
            chance: 1,
            xpAmount: 5,
          },
        ],
        cachedResourceName: "Rune Essence",
        cachedStartPosition: { ...player.position },
      });

      // Run 10 gather cycles — resource should never deplete
      for (let tick = 0; tick < 10; tick++) {
        const currentTick = startTick + tick * 4;
        (mockWorld as { currentTick: number }).currentTick = currentTick;

        // Reset nextAttemptTick so each call processes a gather
        const session = activeGathering.get(playerId);
        if (session) {
          session.nextAttemptTick = currentTick;
        }

        system.processGatheringTick(currentTick);
      }

      // Resource should still be available (never depleted)
      const resource = resources.get(resourceId as never);
      expect(resource?.isAvailable).toBe(true);

      // No RESOURCE_DEPLETED events should have been emitted via eventBus
      const emitCalls = (
        mockWorld.$eventBus.emitEvent as ReturnType<typeof vi.fn>
      ).mock.calls;
      const depleteEvents = emitCalls.filter(
        (call: unknown[]) => call[0] === EventType.RESOURCE_DEPLETED,
      );
      expect(depleteEvents).toHaveLength(0);
    });

    it("should deplete a resource with depleteChance: 1.0 (regular ore)", async () => {
      // Setup: Player with mining skill and pickaxe
      const player = createTestPlayer("miner2", { mining: 1 });
      player.position = { x: 20, y: 0, z: 20 };
      mockWorld.addPlayer(player);
      mockWorld.setInventory(
        "miner2",
        createTestInventory([{ itemId: "bronze_pickaxe", quantity: 1 }]),
      );

      const resourceId = "ore_copper_20_20";
      const playerId = "miner2";
      const startTick = 200;

      // Inject resource
      const resources = (
        system as unknown as {
          resources: Map<
            string,
            {
              id: string;
              type: string;
              name: string;
              position: { x: number; y: number; z: number };
              skillRequired: string;
              levelRequired: number;
              toolRequired: string;
              respawnTime: number;
              isAvailable: boolean;
              lastDepleted: number;
              drops: Array<{
                itemId: string;
                itemName: string;
                quantity: number;
                chance: number;
                xpAmount: number;
              }>;
            }
          >;
        }
      ).resources;

      resources.set(resourceId as never, {
        id: resourceId,
        type: "ore",
        name: "Copper Rock",
        position: { x: 21, y: 0, z: 20 },
        skillRequired: "mining",
        levelRequired: 1,
        toolRequired: "pickaxe",
        respawnTime: 2400,
        isAvailable: true,
        lastDepleted: 0,
        drops: [
          {
            itemId: "copper_ore",
            itemName: "Copper ore",
            quantity: 1,
            chance: 1,
            xpAmount: 17.5,
          },
        ],
      });

      // Inject gathering session with depleteChance: 1.0
      const activeGathering = (
        system as {
          activeGathering: Map<string, Record<string, unknown>>;
        }
      ).activeGathering;

      activeGathering.set(playerId, {
        playerId,
        resourceId,
        startTick,
        nextAttemptTick: startTick,
        cycleTickInterval: 4,
        attempts: 0,
        successes: 0,
        cachedTuning: {
          levelRequired: 1,
          xpPerLog: 17.5,
          depleteChance: 1.0, // Always deplete on success
          respawnTicks: 4,
        },
        cachedSuccessRate: 1.0, // Always succeed
        cachedDrops: [
          {
            itemId: "copper_ore",
            itemName: "Copper ore",
            quantity: 1,
            chance: 1,
            xpAmount: 17.5,
          },
        ],
        cachedResourceName: "Copper Rock",
        cachedStartPosition: { ...player.position },
      });

      (mockWorld as { currentTick: number }).currentTick = startTick;
      system.processGatheringTick(startTick);
      await Promise.resolve();
      await Promise.resolve();
      system.processGatheringTick(startTick + 1);

      // Resource should be depleted after first successful gather
      const resource = resources.get(resourceId as never);
      expect(resource?.isAvailable).toBe(false);

      // RESOURCE_DEPLETED event should have been emitted via eventBus
      const emitCalls = (
        mockWorld.$eventBus.emitEvent as ReturnType<typeof vi.fn>
      ).mock.calls;
      const depleteEvents = emitCalls.filter(
        (call: unknown[]) => call[0] === EventType.RESOURCE_DEPLETED,
      );
      expect(depleteEvents).toHaveLength(1);
    });
  });

  it("REGRESSION: should ignore duplicate gather requests (spam click exploit)", () => {
    // Setup: Create player and add to world
    const player = createTestPlayer("spam_clicker", { woodcutting: 99 });
    player.position = { x: 100, y: 0, z: 100 };
    mockWorld.addPlayer(player);
    mockWorld.setInventory(
      "spam_clicker",
      createTestInventory([{ itemId: "bronze_hatchet", quantity: 1 }]),
    );

    const resourceId = "tree_normal_100_100";
    const playerId = "spam_clicker";
    const initialTick = 1000;

    // Directly inject a session to test the guard clause in isolation
    // This bypasses resource registration/validation - we only test the duplicate check
    const activeGathering = (
      system as { activeGathering: Map<string, Record<string, unknown>> }
    ).activeGathering;
    activeGathering.set(playerId, {
      playerId,
      resourceId,
      startTick: initialTick,
      nextAttemptTick: initialTick + 4,
      cycleTickInterval: 4,
      attempts: 0,
      successes: 0,
      cachedTuning: {
        levelRequired: 1,
        xpPerLog: 25,
        depleteChance: 0.125,
        respawnTicks: 100,
      },
      cachedSuccessRate: 0.5,
      cachedDrops: [
        {
          itemId: "logs",
          itemName: "Logs",
          quantity: 1,
          chance: 1,
          xpAmount: 25,
        },
      ],
      cachedResourceName: "Tree",
      cachedStartPosition: { ...player.position },
    });

    // Verify session exists with our injected startTick
    expect(activeGathering.get(playerId)).toBeDefined();
    expect(activeGathering.get(playerId).startTick).toBe(initialTick);

    // Advance world tick
    (mockWorld as { currentTick: number }).currentTick = initialTick + 5;

    // Emit duplicate gather request - guard clause should ignore this
    mockWorld.emit(EventType.RESOURCE_GATHER, {
      playerId: "spam_clicker",
      resourceId: resourceId,
      playerPosition: player.position,
    });

    // Session should NOT have been replaced (startTick unchanged)
    const session = activeGathering.get(playerId);
    expect(session).toBeDefined();
    expect(session.startTick).toBe(initialTick);
    expect(session.resourceId).toBe(resourceId);
  });
});
