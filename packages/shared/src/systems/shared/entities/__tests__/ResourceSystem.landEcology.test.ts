import { beforeAll, describe, expect, it, vi } from "vitest";

import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { EventType } from "../../../../types/events";
import type { Resource } from "../../../../types/game/resource-processing-types";
import { getExternalResource } from "../../../../utils/ExternalAssetUtils";
import { ResourceSystem } from "../ResourceSystem";

type GatheringSession = {
  playerId: string;
  resourceId: string;
  startTick: number;
  nextAttemptTick: number;
  cycleTickInterval: number;
  attempts: number;
  successes: number;
  pendingRewardOperationId: string | null;
  skill: string;
  toolItemId: null;
  cachedTuning: {
    levelRequired: number;
    xpPerLog: number;
    depleteChance: number;
    respawnTicks: number;
  };
  cachedSuccessRate: number;
  cachedDrops: Resource["drops"];
  cachedResourceName: string;
  cachedStartPosition: { x: number; y: number; z: number };
};

type EcologyInternals = {
  resources: Map<string, Resource>;
  activeGathering: Map<string, GatheringSession>;
  resourceVariants: Map<string, string>;
  manifestResourceIds: Set<string>;
  addActiveGatherer(
    playerId: string,
    resourceId: string,
    tickNumber: number,
  ): void;
  cancelGatheringForPlayer(playerId: string, reason: string): void;
};

type Transition = {
  event: "depleted" | "respawned";
  resourceId: string;
  tick: number;
};

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ResourceSystem production land-node ecology", () => {
  it("keeps 25 agents and every authored preparation tree/ore bounded for 60,000 ticks", async () => {
    const preparationArea = ALL_WORLD_AREAS.preparation_training_grounds;
    expect(preparationArea).toBeDefined();
    const authoredLandNodes = preparationArea.resources.filter(
      (resource) => resource.resourceId !== "ore_essence",
    );
    expect(authoredLandNodes).toHaveLength(11);

    const players = new Map<
      string,
      { position: { x: number; y: number; z: number } }
    >();
    const transitions: Transition[] = [];
    const rewardsByResource = new Map<string, number>();
    const seenOperations = new Set<string>();
    const ambiguousOperations = new Set<string>();
    let freshOperations = 0;
    let commitAttempts = 0;
    let ambiguousResponses = 0;
    let recoveredAmbiguousOperations = 0;
    let committedRewards = 0;
    let awardedXpEvents = 0;
    let currentTick = 0;
    const expectedRetryWarning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const entities = new Map<
      string,
      {
        position: { x: number; y: number; z: number };
        deplete: () => void;
        respawn: () => void;
      }
    >();
    const inventorySystem = {
      getInventory: () => ({ items: [], isFull: false }),
      commitGatheringRewardAtomic: async (
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
        commitAttempts++;
        if (!seenOperations.has(operationId)) {
          seenOperations.add(operationId);
          freshOperations++;
          if (freshOperations % 257 === 0) {
            ambiguousOperations.add(operationId);
            ambiguousResponses++;
            return {
              ok: false as const,
              committed: false as const,
              liveInventoryApplied: false,
              playerId,
              operationId,
              replayed: false,
              skill: input.skill,
              xpAmount: input.xpAmount,
              reward: null,
              secondaryItemId: input.secondaryItemId ?? null,
              retryable: true,
              reason: "persistence_ambiguous" as const,
            };
          }
        } else if (ambiguousOperations.delete(operationId)) {
          recoveredAmbiguousOperations++;
        }
        committedRewards++;
        rewardsByResource.set(
          input.resourceId,
          (rewardsByResource.get(input.resourceId) ?? 0) + 1,
        );
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
            stackable: true,
          },
          secondaryItemId: input.secondaryItemId ?? null,
          awardedXp: input.xpAmount,
          operationCommittedXp: input.xpAmount,
          currentXp: input.xpAmount,
          currentLevel: 99,
        };
      },
    };
    const world = {
      isServer: true,
      currentTick: 0,
      entities,
      getPlayer: (playerId: string) => players.get(playerId),
      getSystem: (name: string) =>
        name === "inventory" ? inventorySystem : null,
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      network: { send: () => undefined },
      chat: { sendSystemMessage: () => undefined, add: () => undefined },
      $eventBus: {
        subscribe: () => ({ unsubscribe: () => undefined }),
        subscribeOnce: () => ({ unsubscribe: () => undefined }),
        request: vi.fn(),
        respond: vi.fn(),
        emitEvent: (event: string, data: unknown) => {
          const payload = data as { resourceId?: string };
          if (event === EventType.RESOURCE_DEPLETED && payload.resourceId) {
            transitions.push({
              event: "depleted",
              resourceId: payload.resourceId,
              tick: currentTick,
            });
          }
          if (event === EventType.RESOURCE_RESPAWNED && payload.resourceId) {
            transitions.push({
              event: "respawned",
              resourceId: payload.resourceId,
              tick: currentTick,
            });
          }
          if (event === EventType.SKILLS_PROGRESS_COMMITTED) awardedXpEvents++;
        },
      },
    };

    const system = new ResourceSystem(world as never);
    const internals = system as unknown as EcologyInternals;
    const resourceIds: string[] = [];
    for (const authored of authoredLandNodes) {
      const manifest = getExternalResource(authored.resourceId);
      expect(manifest, authored.resourceId).not.toBeNull();
      const resourceId = `preparation:${authored.resourceId}`;
      const drops = manifest!.harvestYield.map((drop) => ({ ...drop }));
      internals.resources.set(resourceId, {
        id: resourceId,
        type: manifest!.type as Resource["type"],
        name: manifest!.name,
        position: { ...authored.position },
        skillRequired: manifest!.harvestSkill,
        levelRequired: manifest!.levelRequired,
        toolRequired: manifest!.toolRequired ?? "",
        respawnTime: manifest!.respawnTicks * 600,
        isAvailable: true,
        lastDepleted: 0,
        drops,
      });
      internals.resourceVariants.set(resourceId, authored.resourceId);
      internals.manifestResourceIds.add(resourceId);
      entities.set(resourceId, {
        position: { ...authored.position },
        deplete: () => undefined,
        respawn: () => undefined,
      });
      resourceIds.push(resourceId);
    }

    const agentIds = Array.from(
      { length: 25 },
      (_, index) => `ecology-agent-${String(index).padStart(2, "0")}`,
    );
    for (const agentId of agentIds) {
      players.set(agentId, { position: { x: 0, y: 0, z: 0 } });
    }

    vi.spyOn(Math, "random").mockReturnValue(0);
    const maxObserved = {
      resources: 0,
      activeSessions: 0,
      pendingRewards: 0,
      reservations: 0,
      forestryTimers: 0,
      respawns: 0,
      retryCount: 0,
    };

    for (currentTick = 1; currentTick <= 60_000; currentTick++) {
      world.currentTick = currentTick;
      const sessionCounts = new Map<string, number>();
      for (const session of internals.activeGathering.values()) {
        sessionCounts.set(
          session.resourceId,
          (sessionCounts.get(session.resourceId) ?? 0) + 1,
        );
      }

      for (const agentId of agentIds) {
        if (internals.activeGathering.has(agentId)) continue;
        const targetId = resourceIds
          .filter(
            (resourceId) =>
              internals.resources.get(resourceId)?.isAvailable &&
              (sessionCounts.get(resourceId) ?? 0) < 4,
          )
          .sort(
            (left, right) =>
              (sessionCounts.get(left) ?? 0) -
                (sessionCounts.get(right) ?? 0) || left.localeCompare(right),
          )[0];
        if (!targetId) continue;

        const resource = internals.resources.get(targetId)!;
        const variant = internals.resourceVariants.get(targetId)!;
        const manifest = getExternalResource(variant)!;
        players.get(agentId)!.position = { ...resource.position };
        internals.activeGathering.set(agentId, {
          playerId: agentId,
          resourceId: targetId,
          startTick: currentTick,
          nextAttemptTick: currentTick,
          cycleTickInterval: manifest.baseCycleTicks,
          attempts: 0,
          successes: 0,
          pendingRewardOperationId: null,
          skill: manifest.harvestSkill,
          toolItemId: null,
          cachedTuning: {
            levelRequired: manifest.levelRequired,
            xpPerLog: manifest.harvestYield[0]!.xpAmount,
            depleteChance: manifest.depleteChance,
            respawnTicks: manifest.respawnTicks,
          },
          cachedSuccessRate: 1,
          cachedDrops: resource.drops,
          cachedResourceName: resource.name,
          cachedStartPosition: { ...resource.position },
        });
        internals.addActiveGatherer(agentId, targetId, currentTick);
        sessionCounts.set(targetId, (sessionCounts.get(targetId) ?? 0) + 1);
      }

      system.processGatheringTick(currentTick);
      await flushPromises();

      const ecology = system.getResourceEcologyStats();
      maxObserved.resources = Math.max(
        maxObserved.resources,
        ecology.totalResources,
      );
      maxObserved.activeSessions = Math.max(
        maxObserved.activeSessions,
        ecology.custody.activeSessions,
      );
      maxObserved.pendingRewards = Math.max(
        maxObserved.pendingRewards,
        ecology.custody.pendingRewards,
      );
      maxObserved.reservations = Math.max(
        maxObserved.reservations,
        ecology.custody.resourceReservations,
      );
      maxObserved.forestryTimers = Math.max(
        maxObserved.forestryTimers,
        ecology.forestryTimers,
      );
      maxObserved.respawns = Math.max(
        maxObserved.respawns,
        ecology.scheduledRespawns,
      );
      maxObserved.retryCount = Math.max(
        maxObserved.retryCount,
        ecology.custody.maxRetryCount,
      );

      expect(ecology.totalResources).toBe(11);
      expect(ecology.availableResources + ecology.depletedResources).toBe(11);
      expect(ecology.resourceVariants).toBe(11);
      expect(ecology.manifestResources).toBe(11);
      expect(ecology.custody.activeSessions).toBeLessThanOrEqual(25);
      expect(ecology.custody.pendingRewards).toBeLessThanOrEqual(11);
      expect(ecology.custody.resourceReservations).toBeLessThanOrEqual(11);
      expect(ecology.forestryTimers).toBeLessThanOrEqual(3);
      expect(ecology.scheduledRespawns).toBeLessThanOrEqual(11);
      expect(ecology.forestryActiveGatherers).toBeLessThanOrEqual(
        ecology.custody.activeSessions,
      );
    }

    for (const agentId of [...internals.activeGathering.keys()]) {
      internals.cancelGatheringForPlayer(agentId, "simulation_complete");
    }
    for (let drainTick = 0; drainTick < 10; drainTick++) {
      await flushPromises();
      currentTick++;
      system.processGatheringTick(currentTick);
      if (system.getResourceEcologyStats().custody.pendingRewards === 0) break;
    }

    const finalEcology = system.getResourceEcologyStats();
    expect(finalEcology.custody).toMatchObject({
      activeSessions: 0,
      pendingRewards: 0,
      inFlightRewards: 0,
      retryWaitingRewards: 0,
      resourceReservations: 0,
    });
    expect(finalEcology.forestryActiveGatherers).toBe(0);
    expect(committedRewards).toBe(awardedXpEvents);
    expect(maxObserved).toEqual({
      resources: 11,
      activeSessions: 25,
      pendingRewards: 11,
      reservations: 11,
      forestryTimers: 3,
      respawns: expect.any(Number),
      retryCount: 1,
    });
    expect(maxObserved.respawns).toBeGreaterThan(0);

    const transitionSummary = Object.fromEntries(
      resourceIds.map((resourceId) => [
        resourceId,
        {
          rewards: rewardsByResource.get(resourceId) ?? 0,
          depleted: transitions.filter(
            (transition) =>
              transition.resourceId === resourceId &&
              transition.event === "depleted",
          ).length,
          respawned: transitions.filter(
            (transition) =>
              transition.resourceId === resourceId &&
              transition.event === "respawned",
          ).length,
        },
      ]),
    );
    expect(freshOperations).toBe(committedRewards);
    expect(commitAttempts).toBe(committedRewards + ambiguousResponses);
    expect(ambiguousResponses).toBe(recoveredAmbiguousOperations);
    expect(ambiguousResponses).toBe(513);
    expect(expectedRetryWarning).toHaveBeenCalledTimes(513);
    expect(expectedRetryWarning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Retaining unresolved gathering reward gathering-reward:",
      ),
    );
    expect({
      freshOperations,
      commitAttempts,
      recoveredAmbiguousOperations,
      committedRewards,
      awardedXpEvents,
      transitionSummary,
    }).toEqual({
      freshOperations: 131_868,
      commitAttempts: 132_381,
      recoveredAmbiguousOperations: 513,
      committedRewards: 131_868,
      awardedXpEvents: 131_868,
      transitionSummary: {
        "preparation:tree_oak": {
          rewards: 21_867,
          depleted: 467,
          respawned: 466,
        },
        "preparation:tree_maple": {
          rewards: 33_145,
          depleted: 326,
          respawned: 325,
        },
        "preparation:tree_mahogany": {
          rewards: 732,
          depleted: 732,
          respawned: 731,
        },
        "preparation:tree_magic": {
          rewards: 49_059,
          depleted: 125,
          respawned: 125,
        },
        "preparation:ore_copper": {
          rewards: 9_982,
          depleted: 9_982,
          respawned: 9_982,
        },
        "preparation:ore_tin": {
          rewards: 9_983,
          depleted: 9_983,
          respawned: 9_982,
        },
        "preparation:ore_iron": {
          rewards: 5_449,
          depleted: 5_449,
          respawned: 5_448,
        },
        "preparation:ore_coal": {
          rewards: 1_154,
          depleted: 1_154,
          respawned: 1_153,
        },
        "preparation:ore_mithril": {
          rewards: 297,
          depleted: 297,
          respawned: 297,
        },
        "preparation:ore_adamant": {
          rewards: 150,
          depleted: 150,
          respawned: 149,
        },
        "preparation:ore_runite": {
          rewards: 50,
          depleted: 50,
          respawned: 49,
        },
      },
    });

    for (const resourceId of resourceIds) {
      expect(
        rewardsByResource.get(resourceId) ?? 0,
        resourceId,
      ).toBeGreaterThan(0);
      const sequence = transitions.filter(
        (transition) => transition.resourceId === resourceId,
      );
      const depleted = sequence.filter(
        (transition) => transition.event === "depleted",
      );
      const respawned = sequence.filter(
        (transition) => transition.event === "respawned",
      );
      expect(depleted.length, resourceId).toBeGreaterThan(0);
      expect(respawned.length, resourceId).toBeGreaterThan(0);
      expect(
        depleted.length - respawned.length,
        resourceId,
      ).toBeGreaterThanOrEqual(0);
      expect(
        depleted.length - respawned.length,
        resourceId,
      ).toBeLessThanOrEqual(1);
      for (let index = 1; index < sequence.length; index++) {
        expect(sequence[index]!.event, resourceId).not.toBe(
          sequence[index - 1]!.event,
        );
        expect(sequence[index]!.tick, resourceId).toBeGreaterThan(
          sequence[index - 1]!.tick,
        );
      }
    }
  }, 120_000);
});
