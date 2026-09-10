import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EntityOccupancyMap,
  ITEMS,
  type PrayerActionReceipt,
  type StreamingDuelExecutorCommandReceipt,
  ammunitionService,
  createEntityID,
  getDuelArenaConfig,
  isPositionInsideCombatArena,
  prayerDataProvider,
  worldToTile,
} from "@hyperforge/shared";
import prayersManifest from "../../../../world/assets/manifests/prayers.json";
import weaponsManifest from "../../../../world/assets/manifests/items/weapons.json";

import {
  DuelOrchestrator,
  isLocalDiagnosticDuelRuntime,
  isStreamingDuelMeleeWeaponTypePresentationEligible,
  resolveStandaloneSingleStyleCombatLoadout,
} from "../managers/DuelOrchestrator";
import {
  getAgentManager,
  setAgentManager,
} from "../../../eliza/AgentManager.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../competitive-tactical-strategy.js";
import { TileMovementManager } from "../../ServerNetwork/tile-movement";
import { isStreamingDuelEquipmentPresentationEligible } from "../../../streaming/duel-equipment-presentation.js";

describe("local diagnostic duel runtime boundary", () => {
  const validEnvironment = {
    NODE_ENV: "production",
    DUEL_LOCAL_SMOKE_MODE: "true",
    LOAD_TEST_MODE: "true",
    DUEL_BETTING_ENABLED: "false",
    DUEL_WITH_HYPERBET: "false",
    STREAMING_DUEL_SCHEDULER_ROLE: "authority",
    PUBLIC_API_URL: "http://127.0.0.1:35551",
    PUBLIC_WS_URL: "ws://localhost:35552/ws",
  };

  it("requires every no-money, load-test, authority, and loopback invariant", () => {
    expect(isLocalDiagnosticDuelRuntime(validEnvironment)).toBe(true);
    expect(
      isLocalDiagnosticDuelRuntime({
        ...validEnvironment,
        DUEL_WITH_HYPERBET: "true",
        DUEL_HYPERBET_READ_ONLY_MODE: "true",
      }),
    ).toBe(true);
    expect(
      isLocalDiagnosticDuelRuntime({
        ...validEnvironment,
        DUEL_WITH_HYPERBET: "true",
        DUEL_LOCAL_SOLANA_MODE: "true",
        SOLANA_RPC_URL: "http://127.0.0.1:18899",
      }),
    ).toBe(true);
    expect(
      isLocalDiagnosticDuelRuntime({
        ...validEnvironment,
        DUEL_WITH_HYPERBET: "true",
        DUEL_LOCAL_SOLANA_MODE: "true",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      }),
    ).toBe(false);
    for (const [name, value] of [
      ["NODE_ENV", "development"],
      ["DUEL_LOCAL_SMOKE_MODE", "false"],
      ["LOAD_TEST_MODE", "false"],
      ["DUEL_BETTING_ENABLED", "true"],
      ["DUEL_WITH_HYPERBET", "true"],
      ["STREAMING_DUEL_SCHEDULER_ROLE", "replica"],
      ["PUBLIC_API_URL", "https://arena.example"],
      ["PUBLIC_WS_URL", "wss://arena.example/ws"],
    ]) {
      expect(
        isLocalDiagnosticDuelRuntime({
          ...validEnvironment,
          [name]: value,
        }),
        name,
      ).toBe(false);
    }
  });
});

describe("streaming duel melee presentation gate", () => {
  it("admits every canonical weapon family with certified presentation", () => {
    for (const itemId of [
      "bronze_shortsword",
      "bronze_longsword",
      "bronze_scimitar",
    ]) {
      const weapon = weaponsManifest.find((item) => item.id === itemId);
      expect(weapon, itemId).toBeDefined();
      expect(
        isStreamingDuelMeleeWeaponTypePresentationEligible(weapon?.weaponType),
        itemId,
      ).toBe(true);
    }
    expect(
      isStreamingDuelMeleeWeaponTypePresentationEligible("battleaxe"),
    ).toBe(false);
    expect(
      isStreamingDuelMeleeWeaponTypePresentationEligible("TWO_HAND_SWORD"),
    ).toBe(false);
    expect(isStreamingDuelMeleeWeaponTypePresentationEligible(null)).toBe(
      false,
    );
  });
});

describe("standalone single-style combat loadouts", () => {
  it("uses one deterministic technically fitted loadout for every diagnostic role", () => {
    expect(resolveStandaloneSingleStyleCombatLoadout("melee")).toEqual({
      weaponId: "bronze_shortsword",
      arrowsId: null,
      spellId: null,
    });
    expect(resolveStandaloneSingleStyleCombatLoadout("prayer")).toEqual({
      weaponId: "bronze_shortsword",
      arrowsId: null,
      spellId: null,
    });
    expect(resolveStandaloneSingleStyleCombatLoadout("ranged")).toEqual({
      weaponId: "shortbow",
      arrowsId: "bronze_arrow",
      spellId: null,
    });
    expect(resolveStandaloneSingleStyleCombatLoadout("mage")).toEqual({
      weaponId: "staff_of_air",
      arrowsId: null,
      spellId: "wind_strike",
    });
  });

  it("equips the exact air-staff fixture and records every synthetic asset for cleanup", async () => {
    const equipMageGear = vi.fn(async () => undefined);
    const markProvisionedInventoryItem = vi.fn();
    const fixture = {
      waitForInventoryReadyPlayer: vi.fn(async () => undefined),
      equipMageGear,
      getEquippedWeaponId: vi.fn(() => "staff_of_air"),
      markProvisionedInventoryItem,
    };
    const ensure = (
      DuelOrchestrator.prototype as unknown as {
        ensureStandaloneSingleStyleCombatSetup: (
          this: typeof fixture,
          playerId: string,
          role: "mage",
        ) => Promise<string>;
      }
    ).ensureStandaloneSingleStyleCombatSetup;

    await expect(
      ensure.call(fixture, "sparbot-standalone-mage", "mage"),
    ).resolves.toBe("staff_of_air");
    expect(equipMageGear).toHaveBeenCalledWith(
      "sparbot-standalone-mage",
      "staff_of_air",
      "wind_strike",
      [{ runeId: "mind_rune", quantity: 500 }],
    );
    expect(markProvisionedInventoryItem).toHaveBeenCalledWith(
      "sparbot-standalone-mage",
      "staff_of_air",
    );
  });

  it("fails closed when the requested fixed-role weapon was not attached", async () => {
    const fixture = {
      waitForInventoryReadyPlayer: vi.fn(async () => undefined),
      equipRangedGear: vi.fn(async () => undefined),
      getEquippedWeaponId: vi.fn(() => null),
      markProvisionedInventoryItem: vi.fn(),
    };
    const ensure = (
      DuelOrchestrator.prototype as unknown as {
        ensureStandaloneSingleStyleCombatSetup: (
          this: typeof fixture,
          playerId: string,
          role: "ranged",
        ) => Promise<string>;
      }
    ).ensureStandaloneSingleStyleCombatSetup;

    await expect(
      ensure.call(fixture, "sparbot-standalone-ranged", "ranged"),
    ).rejects.toThrow("diagnostic_single_style_equip_failed:ranged:shortbow");
    expect(fixture.markProvisionedInventoryItem).not.toHaveBeenCalled();
  });
});

describe("DuelOrchestrator autonomy ownership", () => {
  beforeEach(() => {
    prayerDataProvider.loadPrayers(prayersManifest);
    prayerDataProvider.rebuild();
  });

  it("clears stale and live-player obstructions before claiming exact combat marks", () => {
    const config = getDuelArenaConfig();
    const centerX = config.baseX + config.arenaWidth / 2;
    const centerZ = config.baseZ + config.arenaLength / 2;
    const centerTileX = Math.floor(centerX) + 0.5;
    const boundaryZ = Math.round(centerZ);
    const marks = [
      worldToTile(centerTileX, boundaryZ - 0.65),
      worldToTile(centerTileX, boundaryZ + 0.65),
    ] as const;
    const occupancy = new EntityOccupancyMap();
    const entities = new Map<
      string,
      {
        position: { x: number; y: number; z: number };
        data: Record<string, unknown>;
      }
    >();
    const addEntity = (id: string, x: number, z: number): void => {
      entities.set(id, {
        position: { x, y: config.baseY, z },
        data: { position: [x, config.baseY, z] },
      });
      occupancy.occupy(
        createEntityID(id),
        [worldToTile(x, z)],
        1,
        "player",
        false,
      );
    };
    addEntity("agent-a", 0.5, 0.5);
    addEntity("agent-b", 1.5, 0.5);
    addEntity("spectator", marks[0].x + 0.5, marks[0].z + 0.5);
    occupancy.occupy(
      createEntityID("stale-player"),
      [marks[1]],
      1,
      "player",
      false,
    );

    const emit = vi.fn(
      (event: string, payload: { playerId?: string; position?: unknown }) => {
        if (
          event !== "player:teleport" ||
          !payload.playerId ||
          !payload.position ||
          typeof payload.position !== "object"
        ) {
          return;
        }
        const entity = entities.get(payload.playerId);
        if (!entity) return;
        const position = payload.position as {
          x: number;
          y: number;
          z: number;
        };
        entity.position = { ...position };
        entity.data.position = [position.x, position.y, position.z];
        occupancy.occupy(
          createEntityID(payload.playerId),
          [worldToTile(position.x, position.z)],
          1,
          "player",
          false,
        );
      },
    );
    const world = {
      entities: { get: (id: string) => entities.get(id) },
      entityOccupancy: occupancy,
      emit,
      getSystem: () => null,
    };
    const orchestrator = new DuelOrchestrator(
      world as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );

    orchestrator.teleportToCombatPositions("agent-a", "agent-b");
    // Countdown restaging is intentionally idempotent even though both marks
    // are already occupied by the same contestants.
    orchestrator.teleportToCombatPositions("agent-a", "agent-b");

    expect(String(occupancy.getOccupant(marks[0])?.entityId)).toBe("agent-a");
    expect(String(occupancy.getOccupant(marks[1])?.entityId)).toBe("agent-b");
    expect(occupancy.getStats()).toMatchObject({
      trackedEntityCount: 3,
      playerTileCount: 3,
    });
    const spectator = entities.get("spectator")!;
    expect(worldToTile(spectator.position.x, spectator.position.z)).not.toEqual(
      marks[0],
    );
    expect(
      emit.mock.calls.some(
        ([event, payload]) =>
          event === "player:teleport" && payload.playerId === "spectator",
      ),
    ).toBe(true);
  });

  it("restores both contestants through real collision-safe teleport occupancy", () => {
    const occupancy = new EntityOccupancyMap();
    const entities = new Map<
      string,
      {
        position: {
          x: number;
          y: number;
          z: number;
          set(x: number, y: number, z: number): void;
        };
        data: Record<string, unknown>;
      }
    >();
    const addEntity = (id: string, x: number, z: number): void => {
      const position = {
        x,
        y: 0,
        z,
        set(nextX: number, nextY: number, nextZ: number): void {
          this.x = nextX;
          this.y = nextY;
          this.z = nextZ;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [x, 0, z],
          health: 10,
          maxHealth: 10,
          alive: true,
        },
      });
    };
    addEntity("agent-a", 350.5, 405.5);
    addEntity("agent-b", 350.5, 406.5);
    addEntity("spectator", 10.5, 10.5);

    let movement: TileMovementManager;
    const emit = vi.fn(
      (event: string, payload: { playerId?: string; position?: unknown }) => {
        if (
          event !== "player:teleport" ||
          !payload.playerId ||
          !payload.position ||
          typeof payload.position !== "object"
        ) {
          return;
        }
        const position = payload.position as {
          x: number;
          y: number;
          z: number;
        };
        movement.cleanup(payload.playerId);
        movement.syncPlayerPosition(payload.playerId, position);
      },
    );
    const world = {
      entities,
      entityOccupancy: occupancy,
      emit,
      getSystem: () => null,
      collision: {
        hasFlags: () => false,
        isBlocked: () => false,
      },
      faceDirectionManager: { markPlayerMoved: vi.fn() },
    };
    movement = new TileMovementManager(world as never, vi.fn());
    for (const [id, entity] of entities) {
      movement.syncPlayerPosition(id, entity.position);
    }

    const orchestrator = new DuelOrchestrator(
      world as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );
    const contestant = (
      id: string,
    ): { characterId: string; originalPosition: [number, number, number] } => ({
      characterId: id,
      // Deliberately request the same occupied recovery tile for both agents.
      originalPosition: [10.5, 0, 10.5],
    });

    (
      orchestrator as unknown as {
        restoreCycleContestants(
          cycle: {
            agent1: ReturnType<typeof contestant>;
            agent2: ReturnType<typeof contestant>;
          },
          suppressEffect: boolean,
        ): void;
      }
    ).restoreCycleContestants(
      {
        agent1: contestant("agent-a"),
        agent2: contestant("agent-b"),
      },
      true,
    );

    const finalTiles = ["agent-a", "agent-b", "spectator"].map((id) => {
      const position = entities.get(id)!.position;
      return worldToTile(position.x, position.z);
    });
    expect(new Set(finalTiles.map(({ x, z }) => `${x},${z}`)).size).toBe(3);
    expect(finalTiles[2]).toEqual({ x: 10, z: 10 });
    for (const id of ["agent-a", "agent-b"]) {
      const position = entities.get(id)!.position;
      expect(isPositionInsideCombatArena(position.x, position.z)).toBe(false);
      expect(
        String(
          occupancy.getOccupant(worldToTile(position.x, position.z))?.entityId,
        ),
      ).toBe(id);
    }
    expect(occupancy.getStats()).toMatchObject({
      trackedEntityCount: 3,
      playerTileCount: 3,
    });
  });

  it("durably clears a diagnostic autocast before the next duel can freeze", async () => {
    const savePlayerAsync = vi.fn(async () => {});
    const entity = { data: { selectedSpell: "wind_strike" as string | null } };
    const world = {
      isServer: true,
      entities: { get: vi.fn(() => entity) },
      getPlayer: vi.fn(() => entity),
      getSystem: vi.fn((name: string) =>
        name === "database" ? { savePlayerAsync } : null,
      ),
      emit: vi.fn(),
    };
    const orchestrator = new DuelOrchestrator(
      world as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );

    await (
      orchestrator as unknown as {
        restoreSelectedSpell: (
          playerId: string,
          spellId: string | null,
        ) => Promise<void>;
      }
    ).restoreSelectedSpell("agent-a", null);

    expect(entity.data.selectedSpell).toBeNull();
    expect(savePlayerAsync).toHaveBeenCalledWith("agent-a", {
      selectedSpell: null,
    });
  });

  it("recovers pending executor commands globally in order before starting combat controllers", async () => {
    const previousManager = getAgentManager();
    const recoveryOrder: string[] = [];
    const createService = () => ({
      isAutonomousEnabled: vi.fn(() => true),
      setArenaBounds: vi.fn(),
      clearArenaBounds: vi.fn(),
      setAutonomousBehaviorEnabled: vi.fn(),
      invalidateCombatLoadoutObservation: vi.fn(),
      sendChatMessage: vi.fn(async () => "message-id"),
      recoverStreamingDuelExecutorCommand: vi.fn(
        async (
          command: StreamingDuelExecutorCommandReceipt,
        ): Promise<StreamingDuelExecutorCommandReceipt> => {
          recoveryOrder.push(command.operationId);
          return {
            ...command,
            replayed: false,
            completed: true,
            outcome: "accepted",
          };
        },
      ),
    });
    const serviceA = createService();
    const serviceB = createService();
    const services = new Map([
      ["agent-a", serviceA],
      ["agent-b", serviceB],
    ]);
    setAgentManager({
      getAgentService: (id: string) => services.get(id) ?? null,
      shutdown: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as never);

    const movementOperationId = "11111111-1111-4111-8111-111111111111";
    const engagementOperationId = "22222222-2222-4222-8222-222222222222";
    const pending: StreamingDuelExecutorCommandReceipt[] = [
      {
        operationId: movementOperationId,
        playerId: "agent-a",
        requestFingerprint: "aa".repeat(32),
        publicActionObservation: {
          operationId: movementOperationId,
          tick: 7,
          observedAt: 1_800_000_000_001,
          cycleId: "executor-recovery-cycle",
          duelId: "executor-recovery-duel",
          actorId: "agent-a",
          opponentId: "agent-b",
          phase: "FIGHTING",
          combatRole: "ranged",
          tacticalMacro: "kite",
          action: "movement",
          value: "reposition",
        },
        command: {
          kind: "movement",
          mode: "ground",
          target: [349.5, 4, 406.5],
          runMode: true,
        },
        replayed: false,
        completed: false,
        outcome: null,
      },
      {
        operationId: engagementOperationId,
        playerId: "agent-b",
        requestFingerprint: "bb".repeat(32),
        publicActionObservation: {
          operationId: engagementOperationId,
          tick: 8,
          observedAt: 1_800_000_000_002,
          cycleId: "executor-recovery-cycle",
          duelId: "executor-recovery-duel",
          actorId: "agent-b",
          opponentId: "agent-a",
          phase: "FIGHTING",
          combatRole: "melee",
          tacticalMacro: "pressure",
          action: "engagement",
          value: "initial",
        },
        command: {
          kind: "engagement",
          targetId: "agent-a",
          targetType: "player",
        },
        replayed: false,
        completed: false,
        outcome: null,
      },
    ];
    const listPendingStreamingDuelExecutorCommandsAsync = vi.fn(
      async () => pending,
    );
    const cycle = {
      cycleId: "executor-recovery-cycle",
      duelId: "executor-recovery-duel",
      phase: "FIGHTING",
      agent1: {
        characterId: "agent-a",
        name: "Agent A",
        combatLevel: 12,
      },
      agent2: {
        characterId: "agent-b",
        name: "Agent B",
        combatLevel: 11,
      },
    } as never;
    const entities = new Map([
      ["agent-a", { data: {} }],
      ["agent-b", { data: {} }],
    ]);
    const orchestrator = new DuelOrchestrator(
      {
        entities: { get: (id: string) => entities.get(id) },
        getSystem: (name: string) =>
          name === "database"
            ? { listPendingStreamingDuelExecutorCommandsAsync }
            : null,
      } as never,
      () => cycle,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );
    orchestrator.activatePublicActionObservations("executor-recovery-cycle");

    try {
      await orchestrator.startCombatAIs();

      expect(
        listPendingStreamingDuelExecutorCommandsAsync,
      ).toHaveBeenCalledWith("executor-recovery-cycle");
      expect(recoveryOrder).toEqual([
        movementOperationId,
        engagementOperationId,
      ]);
      expect(serviceA.recoverStreamingDuelExecutorCommand).toHaveBeenCalledWith(
        pending[0],
      );
      expect(serviceB.recoverStreamingDuelExecutorCommand).toHaveBeenCalledWith(
        pending[1],
      );
      expect(
        orchestrator
          .getPublicActionObservations("executor-recovery-cycle")
          .map(({ action, outcome }) => [action, outcome]),
      ).toEqual([
        ["movement", "accepted"],
        ["engagement", "accepted"],
      ]);
      expect((orchestrator as any).combatAIs.size).toBe(2);
    } finally {
      orchestrator.stopCombatAIs();
      setAgentManager(previousManager as never);
    }
  });

  it("binds the pre-market policy but withholds the planner runtime from combat", async () => {
    const previousManager = getAgentManager();
    const runtimeA = { useModel: vi.fn(), stop: vi.fn() };
    const runtimeB = { useModel: vi.fn(), stop: vi.fn() };
    const createService = () => ({
      isAutonomousEnabled: vi.fn(() => true),
      setArenaBounds: vi.fn(),
      clearArenaBounds: vi.fn(),
      setAutonomousBehaviorEnabled: vi.fn(),
      invalidateCombatLoadoutObservation: vi.fn(),
      sendChatMessage: vi.fn(async () => "message-id"),
    });
    const serviceA = createService() as never;
    const serviceB = createService() as never;
    const fingerprintA = "aa".repeat(32);
    const fingerprintB = "bb".repeat(32);
    const bindings = new Map([
      [
        "agent-a",
        {
          fingerprint: fingerprintA,
          provider: "openai",
          model: "model-a",
          runtime: runtimeA,
          combatControllerEnabled: true,
        },
      ],
      [
        "agent-b",
        {
          fingerprint: fingerprintB,
          provider: "deterministic",
          model: "deterministic",
          runtime: null,
          combatControllerEnabled: true,
        },
      ],
    ]);
    const services = new Map([
      ["agent-a", serviceA],
      ["agent-b", serviceB],
    ]);
    const fakeManager = {
      getAgentService: (id: string) => services.get(id) ?? null,
      getCompetitiveAgentPolicyBinding: (id: string) =>
        bindings.get(id) ?? null,
      shutdown: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    setAgentManager(fakeManager as never);
    try {
      const contestants = [
        {
          agentId: "agent-a",
          provider: "openai",
          model: "model-a",
          availableCombatStyles: ["melee"],
          preparation: {
            planningPolicyVersion: "policy-v1",
            agentPolicyFingerprint: fingerprintA,
            tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
              "melee",
              [],
            ),
          },
        },
        {
          agentId: "agent-b",
          provider: "deterministic",
          model: "deterministic",
          availableCombatStyles: ["melee"],
          preparation: {
            planningPolicyVersion: "policy-v1",
            agentPolicyFingerprint: fingerprintB,
            tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
              "melee",
              [],
            ),
          },
        },
      ] as never;
      const cycle = {
        cycleId: "policy-cycle",
        phase: "FIGHTING",
        agent1: {
          characterId: "agent-a",
          name: "Agent A",
          combatLevel: 12,
        },
        agent2: {
          characterId: "agent-b",
          name: "Agent B",
          combatLevel: 11,
        },
        competitiveSnapshot: { diagnostic: false, contestants },
      } as never;
      const entities = new Map([
        ["agent-a", { data: {} }],
        ["agent-b", { data: {} }],
      ]);
      const orchestrator = new DuelOrchestrator(
        {
          entities: { get: (id: string) => entities.get(id) },
        } as never,
        () => cycle,
        () => {},
        () => new Map(),
        () => {},
        () => {},
        () => [],
        () => [],
      );

      await expect(
        orchestrator.validateCompetitiveAgentPolicies({
          cycleId: "policy-cycle",
          diagnostic: false,
          contestants,
        }),
      ).resolves.toEqual({ ok: true });
      const validated = (orchestrator as any).validatedCompetitiveAgentPolicies;
      expect(validated.agents.get("agent-a")).toMatchObject({
        service: serviceA,
        binding: expect.objectContaining({ runtime: runtimeA }),
      });
      expect(
        (orchestrator as any).hasCurrentCompetitiveAgentPolicies(cycle),
      ).toBe(true);
      await orchestrator.startCombatAIs();
      expect((orchestrator as any).combatAIs.get("agent-a").runtime).toBeNull();
      expect((orchestrator as any).combatAIs.get("agent-b").runtime).toBeNull();
      expect(
        (orchestrator as any).combatAIs.get("agent-a").config
          .opponentCombatRole,
      ).toBe("melee");
      expect(
        (orchestrator as any).combatAIs.get("agent-b").config
          .opponentCombatRole,
      ).toBe("melee");
      expect(orchestrator.getCombatAIDiagnostics()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            characterId: "agent-a",
            combatRole: "melee",
            roleSwitchAttempts: 0,
            successfulRoleSwitches: 0,
          }),
          expect.objectContaining({
            characterId: "agent-b",
            combatRole: "melee",
            roleSwitchAttempts: 0,
            successfulRoleSwitches: 0,
          }),
        ]),
      );
      expect(runtimeA.useModel).not.toHaveBeenCalled();
      await orchestrator.stopCombatAIs();
      expect(orchestrator.getCombatAIDiagnostics()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            characterId: "agent-a",
            cycleId: "policy-cycle",
            active: false,
            capturedAtMs: expect.any(Number),
          }),
          expect.objectContaining({
            characterId: "agent-b",
            cycleId: "policy-cycle",
            active: false,
            capturedAtMs: expect.any(Number),
          }),
        ]),
      );

      const preparationA = (
        contestants as unknown as Array<{
          preparation: { tacticalStrategy?: unknown };
        }>
      )[0]!.preparation;
      const committedTacticalStrategy = preparationA.tacticalStrategy;
      delete preparationA.tacticalStrategy;
      await expect(
        orchestrator.validateCompetitiveAgentPolicies({
          cycleId: "policy-cycle",
          diagnostic: false,
          contestants,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "competitive_tactical_strategy_unavailable",
      });
      preparationA.tacticalStrategy = committedTacticalStrategy;
      await expect(
        orchestrator.validateCompetitiveAgentPolicies({
          cycleId: "policy-cycle",
          diagnostic: false,
          contestants,
        }),
      ).resolves.toEqual({ ok: true });

      preparationA.tacticalStrategy =
        buildDeterministicCompetitiveTacticalStrategy("ranged");
      const contestantA = contestants[0] as unknown as {
        skillLevels: Array<{ skill: string; level: number }>;
        prayer: { pointUnits: number };
      };
      contestantA.skillLevels = [{ skill: "prayer", level: 1 }];
      contestantA.prayer = { pointUnits: 1_000_000 };
      await expect(
        orchestrator.validateCompetitiveAgentPolicies({
          cycleId: "policy-cycle",
          diagnostic: false,
          contestants,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "competitive_tactical_strategy_unavailable",
      });
      preparationA.tacticalStrategy = committedTacticalStrategy;
      contestantA.prayer = { pointUnits: 0 };
      await expect(
        orchestrator.validateCompetitiveAgentPolicies({
          cycleId: "policy-cycle",
          diagnostic: false,
          contestants,
        }),
      ).resolves.toEqual({ ok: true });

      bindings.set("agent-a", {
        ...bindings.get("agent-a")!,
        runtime: runtimeB,
      });
      expect(
        (orchestrator as any).hasCurrentCompetitiveAgentPolicies(cycle),
      ).toBe(true);
      const replacementService = createService() as never;
      services.set("agent-a", replacementService);
      expect(
        (orchestrator as any).hasCurrentCompetitiveAgentPolicies(cycle),
      ).toBe(false);
      services.set("agent-a", serviceA);
      expect(
        (orchestrator as any).hasCurrentCompetitiveAgentPolicies(cycle),
      ).toBe(true);
      bindings.set("agent-a", {
        ...bindings.get("agent-a")!,
        fingerprint: "cc".repeat(32),
      });
      expect(
        (orchestrator as any).hasCurrentCompetitiveAgentPolicies(cycle),
      ).toBe(false);
      await expect(
        orchestrator.validateCompetitiveAgentPolicies({
          cycleId: "policy-cycle",
          diagnostic: false,
          contestants,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "competitive_agent_policy_drift",
      });
    } finally {
      setAgentManager(previousManager as never);
    }
  });

  it("recovers a contestant that escapes the authoritative arena inset", () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const cycle = {
        phase: "FIGHTING",
        agent1: { characterId: "outside" },
        agent2: { characterId: "inside" },
      };
      const entities = new Map([
        ["outside", { position: { x: 10_000, y: 4, z: 10_000 }, data: {} }],
        ["inside", { position: { x: 350, y: 4, z: 406 }, data: {} }],
      ]);
      const orchestrator = new DuelOrchestrator(
        {
          entities: { get: (id: string) => entities.get(id) },
          emit,
          getSystem: vi.fn(() => null),
        } as never,
        () => cycle as never,
        () => {},
        () => new Map(),
        () => {},
        () => {},
        () => [],
        () => [],
      );
      const bounds = orchestrator.getStreamingArenaMovementBounds();

      orchestrator.startCombatLoop();
      vi.advanceTimersByTime(600);
      orchestrator.stopCombatLoop();

      expect(emit).toHaveBeenCalledWith("player:teleport", {
        playerId: "outside",
        position: {
          x: bounds.maxX - 1.5,
          y: 4,
          z: bounds.maxZ - 1.5,
        },
        suppressEffect: true,
      });
      expect(
        emit.mock.calls.some(
          ([event, payload]) =>
            event === "player:teleport" && payload.playerId === "inside",
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a compact centered streaming footprint with room for projectile spacing", () => {
    const orchestrator = new DuelOrchestrator(
      {
        entities: { get: vi.fn() },
        emit: vi.fn(),
        getSystem: vi.fn(() => null),
      } as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );

    const bounds = orchestrator.getStreamingArenaMovementBounds();
    expect(bounds.maxX - bounds.minX).toBe(14);
    expect(bounds.maxZ - bounds.minZ).toBe(16);
    expect((bounds.minX + bounds.maxX) / 2).toBe(350);
    expect((bounds.minZ + bounds.maxZ) / 2).toBe(406);
    // DuelCombatAI keeps a 2.5-unit wall pad, leaving an eleven-unit
    // north/south target span for the complete eight-unit ranged/magic band.
    expect(bounds.maxZ - bounds.minZ - 5).toBeGreaterThanOrEqual(8);
  });

  it("does not cancel AI spacing paths with separation teleports", () => {
    const emit = vi.fn();
    const entities = new Map([
      ["ranged", { position: { x: 10, y: 0, z: 10 } }],
      ["mage", { position: { x: 10.1, y: 0, z: 10 } }],
    ]);
    const orchestrator = new DuelOrchestrator(
      { entities: { get: (id: string) => entities.get(id) }, emit } as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );
    const internals = orchestrator as unknown as {
      combatAIs: Map<string, object>;
      enforceAgentSeparation: (id1: string, id2: string) => void;
    };

    internals.combatAIs.set("ranged", {});
    internals.combatAIs.set("mage", {});
    internals.enforceAgentSeparation("ranged", "mage");

    expect(emit).not.toHaveBeenCalled();
  });

  it("retains separation fallback for fights without movement AI", () => {
    const emit = vi.fn();
    const entities = new Map([
      ["legacy-1", { position: { x: 10, y: 0, z: 10 } }],
      ["legacy-2", { position: { x: 10.1, y: 0, z: 10 } }],
    ]);
    const orchestrator = new DuelOrchestrator(
      { entities: { get: (id: string) => entities.get(id) }, emit } as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );
    const internals = orchestrator as unknown as {
      enforceAgentSeparation: (id1: string, id2: string) => void;
    };

    internals.enforceAgentSeparation("legacy-1", "legacy-2");

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      "player:teleport",
      "player:teleport",
    ]);
  });

  it("restores each service's pre-duel autonomy state", () => {
    const orchestrator = new DuelOrchestrator(
      {} as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );
    const enabledService = {
      clearArenaBounds: vi.fn(),
      setAutonomousBehaviorEnabled: vi.fn(),
    };
    const poolSparbotService = {
      clearArenaBounds: vi.fn(),
      setAutonomousBehaviorEnabled: vi.fn(),
    };
    (
      orchestrator as unknown as {
        _arenaModeServices: Array<{
          service: typeof enabledService;
          wasAutonomous: boolean;
        }>;
      }
    )._arenaModeServices = [
      { service: enabledService, wasAutonomous: true },
      { service: poolSparbotService, wasAutonomous: false },
    ];

    orchestrator.stopCombatAIs();

    expect(enabledService.clearArenaBounds).toHaveBeenCalledOnce();
    expect(enabledService.setAutonomousBehaviorEnabled).toHaveBeenCalledWith(
      true,
    );
    expect(poolSparbotService.clearArenaBounds).toHaveBeenCalledOnce();
    expect(
      poolSparbotService.setAutonomousBehaviorEnabled,
    ).toHaveBeenCalledWith(false);
  });

  it("serializes pair controller ticks, coalesces overlap, and alternates first mover", async () => {
    const cycle = {
      cycleId: "serialized-controller-cycle",
      phase: "FIGHTING",
      agent1: { characterId: "agent-alpha", name: "Agent Alpha" },
      agent2: { characterId: "agent-beta", name: "Agent Beta" },
      competitiveSnapshot: { diagnostic: true },
    } as never;
    const world = {
      entities: new Map([
        ["agent-alpha", { data: {} }],
        ["agent-beta", { data: {} }],
      ]),
      emit: vi.fn(),
      getSystem: vi.fn(() => null),
    };
    const orchestrator = new DuelOrchestrator(
      world as never,
      () => cycle,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );

    let releaseFirstAlpha!: () => void;
    const firstAlphaGate = new Promise<void>((resolve) => {
      releaseFirstAlpha = resolve;
    });
    let alphaTicks = 0;
    const executionOrder: string[] = [];
    const alpha = {
      externalTick: vi.fn(async () => {
        alphaTicks++;
        executionOrder.push("alpha");
        if (alphaTicks === 1) await firstAlphaGate;
      }),
    };
    const beta = {
      externalTick: vi.fn(async () => {
        executionOrder.push("beta");
      }),
    };
    const combatAIs = (
      orchestrator as unknown as {
        combatAIs: Map<string, { externalTick(): Promise<void> }>;
      }
    ).combatAIs;
    combatAIs.set("agent-alpha", alpha);
    combatAIs.set("agent-beta", beta);

    const firstTick = orchestrator.runCombatAITickOnce();
    const coalescedTick = orchestrator.runCombatAITickOnce();
    expect(coalescedTick).toBe(firstTick);
    await vi.waitFor(() => expect(executionOrder).toEqual(["alpha"]));
    expect(beta.externalTick).not.toHaveBeenCalled();

    releaseFirstAlpha();
    await firstTick;
    expect(executionOrder).toEqual(["alpha", "beta"]);

    executionOrder.length = 0;
    await orchestrator.runCombatAITickOnce();
    expect(executionOrder).toEqual(["beta", "alpha"]);
    expect(alpha.externalTick).toHaveBeenCalledTimes(2);
    expect(beta.externalTick).toHaveBeenCalledTimes(2);
  });

  it("pairs manifest-normalized bows with ammunition the combat service accepts", () => {
    const fixtureItems = [
      {
        id: "shortbow",
        name: "Shortbow",
        type: "weapon",
        equipSlot: "2h",
        attackType: "RANGED",
        weaponType: "BOW",
        bonuses: { attackRanged: 8 },
        requirements: { skills: { ranged: 1 } },
      },
      {
        id: "yew_shortbow",
        name: "Yew shortbow",
        type: "weapon",
        equipSlot: "2h",
        attackType: "RANGED",
        weaponType: "BOW",
        bonuses: { attackRanged: 47 },
        requirements: { skills: { ranged: 40 } },
      },
      {
        id: "yew_longbow",
        name: "Yew longbow",
        type: "weapon",
        equipSlot: "2h",
        attackType: "RANGED",
        weaponType: "BOW",
        bonuses: { attackRanged: 47 },
        requirements: { skills: { ranged: 40 } },
      },
      {
        id: "rune_arrow",
        name: "Rune arrow",
        type: "ammunition",
        equipSlot: "arrows",
        bonuses: { rangedStrength: 49 },
        requirements: { skills: { ranged: 40 } },
      },
    ];
    const previousItems = new Map(
      fixtureItems.map((item) => [item.id, ITEMS.get(item.id)]),
    );
    for (const item of fixtureItems) ITEMS.set(item.id, item as never);

    const equipmentSystem = {
      getPlayerEquipment: vi.fn(() => ({ weapon: null, arrows: null })),
      canPlayerEquipItem: vi.fn((_playerId: string, itemId: string) => {
        const item = ITEMS.get(String(itemId));
        const requiredLevel =
          item?.requirements?.skills?.ranged ?? item?.requirements?.level ?? 1;
        return requiredLevel <= 40;
      }),
    };
    const world = {
      entities: {
        get: vi.fn(() => ({
          data: { skills: { ranged: { level: 40 } } },
        })),
      },
      getSystem: vi.fn((name: string) =>
        name === "equipment" ? equipmentSystem : null,
      ),
    };
    const orchestrator = new DuelOrchestrator(
      world as never,
      () => null,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );

    try {
      const setup = (
        orchestrator as unknown as {
          pickBestRangedWeapon: (characterId: string) => {
            bowId: string;
            arrowId: string;
          };
        }
      ).pickBestRangedWeapon("ranged-agent");

      expect(["yew_shortbow", "yew_longbow"]).toContain(setup.bowId);
      expect(setup.arrowId).toBe("rune_arrow");
      expect(
        ammunitionService.areArrowsCompatible(setup.bowId, setup.arrowId),
      ).toBe(true);
    } finally {
      for (const [itemId, previous] of previousItems) {
        if (previous) ITEMS.set(itemId, previous);
        else ITEMS.delete(itemId);
      }
    }
  });
});

type CompetitiveFixtureOptions = {
  alphaWeapon?: string | null;
  betaWeapon?: string | null;
  alphaArrows?: { itemId: string; quantity: number } | null;
  betaArrows?: { itemId: string; quantity: number } | null;
  alphaBody?: string | null;
  betaBody?: string | null;
  alphaHelmet?: string | null;
  betaHelmet?: string | null;
  alphaInventory?: Array<{ slot: number; itemId: string; quantity: number }>;
  betaInventory?: Array<{ slot: number; itemId: string; quantity: number }>;
  alphaSpell?: string | null;
  betaSpell?: string | null;
  alphaPrayerPointUnits?: number;
  betaPrayerPointUnits?: number;
  alphaActivePrayers?: string[];
  betaActivePrayers?: string[];
  synthetic?: boolean;
  skillsSystemOnly?: boolean;
  staleEntityHealth?: boolean;
  activePairProjectile?: boolean;
  useProductionPresentationGate?: boolean;
  playerReady?: (playerId: string) => boolean;
};

function createCompetitiveFixture(options: CompetitiveFixtureOptions = {}) {
  const ids = ["competitive-alpha", "competitive-beta"] as const;
  const makeSkills = () => ({
    attack: { level: 40 },
    strength: { level: 40 },
    defense: { level: 40 },
    constitution: { level: 40 },
    ranged: { level: 40 },
    magic: { level: 40 },
    prayer: { level: 40 },
  });
  const entities = new Map(
    ids.map((id, index) => [
      id,
      {
        id,
        position: { x: index * 2, y: 0, z: 0 },
        data: {
          name: id,
          health: options.staleEntityHealth ? 10 : 40,
          maxHealth: options.staleEntityHealth ? 10 : 40,
          position: [index * 2, 0, 0] as [number, number, number],
          skills: options.skillsSystemOnly ? undefined : makeSkills(),
          selectedSpell:
            index === 0
              ? (options.alphaSpell ?? null)
              : (options.betaSpell ?? null),
        },
      },
    ]),
  );
  const inventories = new Map([
    [
      ids[0],
      {
        playerId: ids[0],
        items: [...(options.alphaInventory ?? [])],
        coins: 0,
      },
    ],
    [
      ids[1],
      {
        playerId: ids[1],
        items: [...(options.betaInventory ?? [])],
        coins: 0,
      },
    ],
  ]);
  const slot = (itemId: string | null, quantity = 1) =>
    itemId
      ? { itemId, item: { id: itemId }, quantity }
      : { itemId: null, item: null };
  const equipment = new Map([
    [
      ids[0],
      {
        weapon: slot(
          options.alphaWeapon === undefined
            ? "launch_test_blade"
            : options.alphaWeapon,
        ),
        arrows: slot(
          options.alphaArrows?.itemId ?? null,
          options.alphaArrows?.quantity,
        ),
        shield: slot(null),
        helmet: slot(
          options.alphaHelmet === undefined
            ? "launch_test_helmet"
            : options.alphaHelmet,
        ),
        body: slot(options.alphaBody ?? null),
      },
    ],
    [
      ids[1],
      {
        weapon: slot(
          options.betaWeapon === undefined
            ? "launch_test_blade"
            : options.betaWeapon,
        ),
        arrows: slot(
          options.betaArrows?.itemId ?? null,
          options.betaArrows?.quantity,
        ),
        shield: slot(null),
        helmet: slot(
          options.betaHelmet === undefined
            ? "launch_test_helmet"
            : options.betaHelmet,
        ),
        body: slot(options.betaBody ?? null),
      },
    ],
  ]);
  const equipItemDirect = vi.fn(
    async (_playerId: string, _itemId: string, _quantity = 1) => ({
      success: true,
      displacedItems: [],
    }),
  );
  const switchOwnedCombatLoadout = vi.fn(
    async (
      playerId: string,
      input: {
        targetRole: string;
        allowedLoadouts: Record<
          string,
          { weaponId: string } | null | undefined
        >;
      },
    ) => {
      const nextWeaponId = input.allowedLoadouts[input.targetRole]?.weaponId;
      const playerEquipment = equipment.get(playerId as (typeof ids)[number]);
      if (nextWeaponId && playerEquipment) {
        playerEquipment.weapon = slot(nextWeaponId);
      }
      return {
        ok: true,
        changed: true,
        replayed: false,
      };
    },
  );
  const addItemDirect = vi.fn(
    async (_playerId: string, _item: { itemId: string; quantity: number }) =>
      true,
  );
  const unequipItemDirect = vi.fn(
    async (playerId: string, slotName: "weapon" | "arrows" | "shield") => {
      const playerEquipment = equipment.get(playerId as (typeof ids)[number])!;
      const equipped = playerEquipment[slotName];
      if (equipped?.itemId) {
        const inventory = inventories.get(playerId as (typeof ids)[number])!;
        const nextSlot =
          inventory.items.reduce((max, item) => Math.max(max, item.slot), -1) +
          1;
        inventory.items.push({
          slot: nextSlot,
          itemId: equipped.itemId,
          quantity: equipped.quantity ?? 1,
        });
      }
      playerEquipment[slotName] = slot(null);
      return { success: true };
    },
  );
  const removeItem = vi.fn(
    async ({
      playerId,
      itemId,
      quantity,
      slot: inventorySlot,
    }: {
      playerId: string;
      itemId: string;
      quantity: number;
      slot: number;
    }) => {
      const inventory = inventories.get(playerId as (typeof ids)[number])!;
      const index = inventory.items.findIndex(
        (item) => item.slot === inventorySlot && item.itemId === itemId,
      );
      if (index < 0) return false;
      const item = inventory.items[index]!;
      if (item.quantity > quantity) item.quantity -= quantity;
      else inventory.items.splice(index, 1);
      return true;
    },
  );
  const prayerStates = new Map<
    string,
    { pointUnits: number; active: string[] }
  >([
    [
      ids[0],
      {
        pointUnits: options.alphaPrayerPointUnits ?? 40_000_000,
        active: [...(options.alphaActivePrayers ?? [])],
      },
    ],
    [
      ids[1],
      {
        pointUnits: options.betaPrayerPointUnits ?? 40_000_000,
        active: [...(options.betaActivePrayers ?? [])],
      },
    ],
  ]);
  const deactivateAllPrayers = vi.fn(
    async (id: string, operationId: string): Promise<PrayerActionReceipt> => {
      const state = prayerStates.get(id)!;
      state.active = [];
      return {
        success: true,
        committed: true,
        playerId: id,
        operationId,
        replayed: false,
        pointUnits: state.pointUnits,
        points: Math.ceil(state.pointUnits / 1_000_000),
        maxPoints: 40,
        activePrayers: [],
      };
    },
  );
  const restorePrayerPoints = vi.fn(
    async (id: string, amount: number, operationId: string) => {
      const state = prayerStates.get(id)!;
      state.pointUnits = Math.min(
        40_000_000,
        state.pointUnits + Math.round(amount * 1_000_000),
      );
      return {
        success: true,
        committed: true,
        playerId: id,
        operationId,
        replayed: false,
        pointUnits: state.pointUnits,
        points: Math.ceil(state.pointUnits / 1_000_000),
        maxPoints: 40,
        activePrayers: [...state.active],
      };
    },
  );
  const emit = vi.fn();
  const hasActiveProjectilesBetween = vi.fn(
    () => options.activePairProjectile === true,
  );
  const quiesceAutoAttacksBetween = vi.fn(() => true);
  const forceEndCombat = vi.fn();
  const waitForProjectileCustodySettlements = vi.fn(async () => {});
  const world = {
    entities: { get: (id: string) => entities.get(id as (typeof ids)[number]) },
    getPlayer: (id: string) => entities.get(id as (typeof ids)[number]),
    emit,
    getSystem: (name: string) => {
      if (name === "player") {
        return {
          isPlayerReady: (id: string) => options.playerReady?.(id) ?? true,
        };
      }
      if (name === "equipment") {
        return {
          getPlayerEquipment: (id: string) =>
            equipment.get(id as (typeof ids)[number]),
          canPlayerEquipItem: () => true,
          equipItemDirect,
          unequipItemDirect,
          switchOwnedCombatLoadout,
        };
      }
      if (name === "inventory") {
        return {
          getInventory: (id: string) =>
            inventories.get(id as (typeof ids)[number]),
          isInventoryReady: () => true,
          addItemDirect,
          removeItem,
        };
      }
      if (name === "prayer") {
        return {
          getPrayerCustody: (id: string) => {
            const state = prayerStates.get(id);
            return {
              ready: Boolean(state),
              persistenceHealthy: Boolean(state),
              pointUnits: state?.pointUnits ?? 0,
              points: Math.ceil((state?.pointUnits ?? 0) / 1_000_000),
              maxPoints: 40,
              activePrayers: [...(state?.active ?? [])],
            };
          },
          deactivateAllPrayers,
          restorePrayerPoints,
        };
      }
      if (name === "skills") {
        return {
          getSkills: () => makeSkills(),
        };
      }
      if (name === "combat") {
        return {
          hasActiveProjectilesBetween,
          quiesceAutoAttacksBetween,
          forceEndCombat,
          waitForProjectileCustodySettlements,
        };
      }
      return null;
    },
  };
  let cycle: Record<string, unknown> | null = null;
  const orchestrator = new DuelOrchestrator(
    world as never,
    () => cycle as never,
    () => {},
    () => new Map(),
    () => {},
    () => {},
    () => [],
    () => [],
    () => options.synthetic === true,
    null,
    options.useProductionPresentationGate
      ? isStreamingDuelEquipmentPresentationEligible
      : (itemId, slotName) =>
          itemId.startsWith("launch_test_") ||
          isStreamingDuelEquipmentPresentationEligible(itemId, slotName),
  );
  const agent1 = orchestrator.createContestant(ids[0], ids[1])!;
  const agent2 = orchestrator.createContestant(ids[1], ids[0])!;
  cycle = {
    cycleId: "competitive-cycle",
    phase: "ANNOUNCEMENT",
    agent1,
    agent2,
  };
  return {
    ids,
    entities,
    inventories,
    equipment,
    equipItemDirect,
    unequipItemDirect,
    switchOwnedCombatLoadout,
    addItemDirect,
    removeItem,
    prayerStates,
    deactivateAllPrayers,
    restorePrayerPoints,
    emit,
    hasActiveProjectilesBetween,
    quiesceAutoAttacksBetween,
    forceEndCombat,
    waitForProjectileCustodySettlements,
    orchestrator,
    agent1,
    agent2,
    cycle: cycle!,
  };
}

describe.sequential("DuelOrchestrator competitive loadout boundary", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const fixtureItems = [
    {
      id: "launch_test_blade",
      name: "Launch Test Blade",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "melee",
      weaponType: "sword",
      equipable: true,
    },
    {
      id: "bronze_shortsword",
      name: "Bronze Shortsword",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "melee",
      weaponType: "sword",
      equipable: true,
    },
    {
      id: "bronze_dagger",
      name: "Bronze Dagger",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "melee",
      weaponType: "dagger",
      equipable: true,
    },
    {
      id: "bronze_full_helm",
      name: "Bronze Full Helm",
      type: "armor",
      equipSlot: "helmet",
      equipable: true,
    },
    {
      id: "launch_test_helmet",
      name: "Launch Test Helmet",
      type: "armor",
      equipSlot: "helmet",
      equipable: true,
    },
    {
      id: "launch_test_shield",
      name: "Launch Test Shield",
      type: "armor",
      equipSlot: "shield",
      equipable: true,
      bonuses: {
        defenseStab: 4,
        defenseSlash: 4,
        defenseCrush: 4,
      },
    },
    {
      id: "launch_test_melee_body",
      name: "Launch Test Melee Body",
      type: "armor",
      equipSlot: "body",
      equipable: true,
      bonuses: {
        defenseStab: 4,
        defenseSlash: 4,
        defenseCrush: 4,
      },
    },
    {
      id: "launch_test_ranged_body",
      name: "Launch Test Ranged Body",
      type: "armor",
      equipSlot: "body",
      equipable: true,
      bonuses: {
        attackRanged: 8,
        defenseRanged: 2,
      },
    },
    {
      id: "shortbow",
      name: "Shortbow",
      type: "weapon",
      equipSlot: "2h",
      attackType: "ranged",
      weaponType: "bow",
      equipable: true,
    },
    {
      id: "bronze_arrow",
      name: "Bronze Arrow",
      type: "ammunition",
      equipSlot: "arrows",
      equipable: true,
    },
    {
      id: "rune_arrow",
      name: "Rune Arrow",
      type: "ammunition",
      equipSlot: "arrows",
      equipable: true,
    },
    {
      id: "staff_of_air",
      name: "Staff of Air",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "magic",
      weaponType: "staff",
      equipable: true,
    },
  ];
  const previousItems = new Map<string, unknown>();

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    for (const item of fixtureItems) {
      previousItems.set(item.id, ITEMS.get(item.id));
      ITEMS.set(item.id, item as never);
    }
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    for (const item of fixtureItems) {
      const previous = previousItems.get(item.id);
      if (previous) ITEMS.set(item.id, previous as never);
      else ITEMS.delete(item.id);
    }
    previousItems.clear();
  });

  it("freezes one deterministic bettor-visible digest before combat prep", () => {
    const fixture = createCompetitiveFixture({
      alphaInventory: [{ slot: 0, itemId: "cooked_fish", quantity: 3 }],
    });

    const inspected = fixture.orchestrator.inspectCompetitiveLoadout(
      fixture.ids[0],
    );
    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );

    expect(inspected).toMatchObject({ ok: true, diagnostic: false });
    expect(frozen).toEqual(inspected);
    expect(frozen.ok && frozen.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.agent1).toMatchObject({
      loadoutFingerprint: frozen.ok ? frozen.fingerprint : null,
      loadoutFrozen: true,
      availableCombatStyles: expect.arrayContaining(["melee"]),
      combatLoadouts: {
        melee: expect.objectContaining({
          role: "melee",
          weaponId: "launch_test_blade",
        }),
      },
    });
  });

  it("fails closed until the authoritative player projection is hydrated", () => {
    let ready = false;
    const fixture = createCompetitiveFixture({ playerReady: () => ready });

    expect(
      fixture.orchestrator.inspectCompetitiveLoadout(fixture.ids[0]),
    ).toEqual({ ok: false, reason: "player_state_not_ready" });

    ready = true;
    expect(
      fixture.orchestrator.inspectCompetitiveLoadout(fixture.ids[0]),
    ).toMatchObject({ ok: true, diagnostic: false });
  });

  it("freezes the authoritative SkillsSystem state when entity data has no skills", () => {
    const fixture = createCompetitiveFixture({ skillsSystemOnly: true });

    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );
    const state = fixture.orchestrator.getFrozenCompetitiveState(
      fixture.ids[0],
    );

    expect(frozen).toMatchObject({ ok: true, diagnostic: false });
    expect(fixture.agent1).toMatchObject({ combatLevel: 51, maxHp: 40 });
    expect(state?.skillLevels).toEqual([
      { skill: "attack", level: 40 },
      { skill: "constitution", level: 40 },
      { skill: "defense", level: 40 },
      { skill: "magic", level: 40 },
      { skill: "prayer", level: 40 },
      { skill: "ranged", level: 40 },
      { skill: "strength", level: 40 },
    ]);
  });

  it("restores and tracks duel health from authoritative skills instead of stale entity defaults", () => {
    const fixture = createCompetitiveFixture({
      skillsSystemOnly: true,
      staleEntityHealth: true,
    });

    expect(fixture.agent1).toMatchObject({ currentHp: 10, maxHp: 40 });

    fixture.orchestrator.restoreHealth(fixture.ids[0]);

    expect(fixture.entities.get(fixture.ids[0])?.data).toMatchObject({
      health: 40,
      maxHealth: 40,
    });
    expect(fixture.agent1).toMatchObject({ currentHp: 40, maxHp: 40 });

    // A stale writer cannot change the published maximum away from the
    // already-authoritative constitution level.
    fixture.entities.get(fixture.ids[0])!.data.health = 10;
    fixture.entities.get(fixture.ids[0])!.data.maxHealth = 10;
    fixture.orchestrator.updateContestantHp();
    expect(fixture.agent1).toMatchObject({ currentHp: 10, maxHp: 40 });
  });

  it("binds exact prayer units into the bettor-visible loadout digest", () => {
    const full = createCompetitiveFixture({
      alphaPrayerPointUnits: 40_000_000,
    });
    const partiallySpent = createCompetitiveFixture({
      alphaPrayerPointUnits: 39_999_999,
    });

    const fullFreeze = full.orchestrator.freezeCompetitiveLoadout(full.agent1);
    const spentFreeze = partiallySpent.orchestrator.freezeCompetitiveLoadout(
      partiallySpent.agent1,
    );

    expect(fullFreeze.ok).toBe(true);
    expect(spentFreeze.ok).toBe(true);
    expect(fullFreeze.ok && spentFreeze.ok && fullFreeze.fingerprint).not.toBe(
      spentFreeze.ok ? spentFreeze.fingerprint : null,
    );
    expect(partiallySpent.agent1).toMatchObject({
      prayerPointUnits: 39_999_999,
      prayerPoints: 40,
      prayerMaxPoints: 40,
    });
  });

  it("durably deactivates ambient prayers before allowing a market freeze", async () => {
    const fixture = createCompetitiveFixture({
      alphaActivePrayers: ["battle_focus"],
      alphaPrayerPointUnits: 12_345_678,
    });

    expect(
      fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent1),
    ).toEqual({ ok: false, reason: "active_prayers_not_frozen" });

    const prepared =
      await fixture.orchestrator.preparePrayerForCompetitiveFreeze(
        fixture.ids[0],
      );
    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );

    expect(prepared).toEqual({ ok: true });
    expect(fixture.deactivateAllPrayers).toHaveBeenCalledOnce();
    expect(fixture.prayerStates.get(fixture.ids[0])).toEqual({
      pointUnits: 12_345_678,
      active: [],
    });
    expect(frozen.ok).toBe(true);
    expect(fixture.agent1.prayerPointUnits).toBe(12_345_678);
  });

  it("begins durable prayer teardown at terminal resolution without restoring spent points", async () => {
    const fixture = createCompetitiveFixture({
      alphaActivePrayers: ["superhuman_strength"],
      alphaPrayerPointUnits: 12_345_678,
      betaActivePrayers: ["hawk_eye"],
      betaPrayerPointUnits: 23_456_789,
    });
    fixture.cycle.phase = "FIGHTING";

    fixture.orchestrator.startResolution(null, null, "draw");

    await vi.waitFor(() => {
      expect(fixture.deactivateAllPrayers).toHaveBeenCalledTimes(2);
    });
    await Promise.all(
      fixture.deactivateAllPrayers.mock.results.map(({ value }) => value),
    );
    expect(fixture.prayerStates.get(fixture.ids[0])).toEqual({
      pointUnits: 12_345_678,
      active: [],
    });
    expect(fixture.prayerStates.get(fixture.ids[1])).toEqual({
      pointUnits: 23_456_789,
      active: [],
    });
    expect(fixture.restorePrayerPoints).not.toHaveBeenCalled();
  });

  it("durably deactivates arena prayers when a duel aborts before resolution", async () => {
    const fixture = createCompetitiveFixture({
      alphaActivePrayers: ["superhuman_strength"],
      alphaPrayerPointUnits: 9_876_543,
    });

    await fixture.orchestrator.cleanupAfterAbort(fixture.cycle as never);

    expect(fixture.deactivateAllPrayers).toHaveBeenCalledOnce();
    expect(fixture.deactivateAllPrayers).toHaveBeenCalledWith(
      fixture.ids[0],
      `duel-prayer-teardown:competitive-cycle:${fixture.ids[0]}`,
    );
    expect(fixture.prayerStates.get(fixture.ids[0])).toEqual({
      pointUnits: 9_876_543,
      active: [],
    });
    expect(fixture.restorePrayerPoints).not.toHaveBeenCalled();
  });

  it("retries a rejected prayer teardown with one deterministic operation id", async () => {
    const fixture = createCompetitiveFixture({
      alphaActivePrayers: ["superhuman_strength"],
      alphaPrayerPointUnits: 8_765_432,
    });
    const committedDeactivate =
      fixture.deactivateAllPrayers.getMockImplementation()!;
    let rejectFirstAlphaAttempt = true;
    fixture.deactivateAllPrayers.mockImplementation(
      async (playerId: string, operationId: string) => {
        const state = fixture.prayerStates.get(playerId)!;
        if (playerId === fixture.ids[0] && rejectFirstAlphaAttempt) {
          rejectFirstAlphaAttempt = false;
          return {
            success: false,
            committed: false,
            playerId,
            operationId,
            replayed: false,
            pointUnits: state.pointUnits,
            points: Math.ceil(state.pointUnits / 1_000_000),
            maxPoints: 40,
            activePrayers: [...state.active],
            reason: "persistence_failed" as const,
            message: "Prayer deactivation could not be committed",
          };
        }
        return committedDeactivate(playerId, operationId);
      },
    );

    await expect(
      fixture.orchestrator.cleanupAfterAbort(fixture.cycle as never),
    ).rejects.toThrow(
      `duel_prayer_deactivation_failed:${fixture.ids[0]}:persistence_failed`,
    );
    await fixture.orchestrator.cleanupAfterAbort(fixture.cycle as never);

    const alphaCalls = fixture.deactivateAllPrayers.mock.calls.filter(
      ([playerId]) => playerId === fixture.ids[0],
    );
    expect(alphaCalls).toHaveLength(2);
    expect(alphaCalls[0]?.[1]).toBe(alphaCalls[1]?.[1]);
    expect(fixture.prayerStates.get(fixture.ids[0])).toEqual({
      pointUnits: 8_765_432,
      active: [],
    });
    expect(fixture.restorePrayerPoints).not.toHaveBeenCalled();
  });

  it("waits for an in-flight combat tick before inspecting terminal prayer custody", async () => {
    let releaseTick!: () => void;
    const tickGate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const prayerState = {
      pointUnits: 7_654_321,
      activePrayers: [] as string[],
    };
    const tickCompletion = tickGate.then(() => {
      prayerState.activePrayers = ["superhuman_strength"];
    });
    const deactivateAllPrayers = vi.fn(
      async (playerId: string, operationId: string) => {
        prayerState.activePrayers = [];
        return {
          success: true,
          committed: true,
          playerId,
          operationId,
          replayed: false,
          pointUnits: prayerState.pointUnits,
          points: 8,
          maxPoints: 40,
          activePrayers: [],
        } satisfies PrayerActionReceipt;
      },
    );
    const entities = new Map([
      ["tick-alpha", { data: {} }],
      ["tick-beta", { data: {} }],
    ]);
    const cycle = {
      cycleId: "tick-race-cycle",
      phase: "FIGHTING",
      agent1: { characterId: "tick-alpha", name: "Tick Alpha" },
      agent2: { characterId: "tick-beta", name: "Tick Beta" },
      competitiveSnapshot: { diagnostic: false },
    } as never;
    const world = {
      entities: { get: (id: string) => entities.get(id) },
      emit: vi.fn(),
      getSystem: (name: string) =>
        name === "prayer"
          ? {
              getPrayerCustody: (playerId: string) => ({
                ready: true,
                persistenceHealthy: true,
                pointUnits: prayerState.pointUnits,
                points: 8,
                maxPoints: 40,
                activePrayers:
                  playerId === "tick-alpha"
                    ? [...prayerState.activePrayers]
                    : [],
              }),
              deactivateAllPrayers,
            }
          : null,
    };
    const orchestrator = new DuelOrchestrator(
      world as never,
      () => cycle,
      () => {},
      () => new Map(),
      () => {},
      () => {},
      () => [],
      () => [],
    );
    const stop = vi.fn();
    const stopAndWaitForIdle = vi.fn(async () => {
      stop();
      await tickCompletion;
    });
    (
      orchestrator as unknown as {
        combatAIs: Map<
          string,
          {
            getStats(): Record<string, unknown>;
            stop(): void;
            stopAndWaitForIdle(): Promise<void>;
          }
        >;
      }
    ).combatAIs.set("tick-alpha", {
      getStats: () => ({
        combatRole: "melee",
        successfulRoleSwitches: 0,
        roleSwitchAttempts: 0,
        roleSwitchFailures: 0,
        engagementAttempts: 0,
        foodUseAttempts: 0,
        movementRequests: 0,
        movementPathsActive: 0,
        movementPathsInactive: 0,
        minObservedDistance: null,
        maxObservedDistance: 0,
        totalDamageDealt: 0,
      }),
      stop,
      stopAndWaitForIdle,
    });

    orchestrator.startResolution(null, null, "draw");
    releaseTick();
    await vi.waitFor(() => {
      expect(deactivateAllPrayers).toHaveBeenCalledWith(
        "tick-alpha",
        "duel-prayer-teardown:tick-race-cycle:tick-alpha",
      );
    });

    expect(stopAndWaitForIdle).toHaveBeenCalledOnce();
    expect(prayerState.activePrayers).toEqual([]);
  });

  it.each([
    {
      terminalPath: "aborted",
      cleanup: (
        orchestrator: DuelOrchestrator,
        cycle: Record<string, unknown>,
      ) => orchestrator.cleanupAfterAbort(cycle as never),
    },
    {
      terminalPath: "resolved",
      cleanup: (
        orchestrator: DuelOrchestrator,
        cycle: Record<string, unknown>,
      ) => orchestrator.cleanupAfterDuel(cycle as never, new Map()),
    },
  ])(
    "waits for controller idleness before $terminalPath equipment and food cleanup",
    async ({ cleanup }) => {
      const fixture = createCompetitiveFixture({});
      let releaseTick!: () => void;
      const tickIdle = new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
      const cleanupAgentCombatSetup = vi.fn(async () => {});
      const removeDuelFood = vi.fn(async () => {});
      const stopAndWaitForIdle = vi.fn(async () => {
        await tickIdle;
      });
      const internals = fixture.orchestrator as unknown as {
        combatAIs: Map<
          string,
          {
            getStats(): Record<string, unknown>;
            stopAndWaitForIdle(): Promise<void>;
          }
        >;
        cleanupAgentCombatSetup(playerId: string): Promise<void>;
        removeDuelFood(
          playerId: string,
          trackedSlots: readonly unknown[],
        ): Promise<void>;
      };
      internals.cleanupAgentCombatSetup = cleanupAgentCombatSetup;
      internals.removeDuelFood = removeDuelFood;
      internals.combatAIs.set(fixture.ids[0], {
        getStats: () => ({
          combatRole: "melee",
          successfulRoleSwitches: 0,
          roleSwitchAttempts: 0,
          roleSwitchFailures: 0,
          engagementAttempts: 0,
          foodUseAttempts: 0,
          movementRequests: 0,
          movementPathsActive: 0,
          movementPathsInactive: 0,
          minObservedDistance: null,
          maxObservedDistance: 0,
          totalDamageDealt: 0,
        }),
        stopAndWaitForIdle,
      });

      void fixture.orchestrator.stopCombatAIs();
      const terminalCleanup = cleanup(fixture.orchestrator, fixture.cycle);
      await Promise.resolve();

      expect(cleanupAgentCombatSetup).not.toHaveBeenCalled();
      expect(removeDuelFood).not.toHaveBeenCalled();

      releaseTick();
      await terminalCleanup;

      expect(stopAndWaitForIdle).toHaveBeenCalledOnce();
      expect(cleanupAgentCombatSetup).toHaveBeenCalledTimes(2);
      expect(removeDuelFood).toHaveBeenCalledTimes(2);
    },
  );

  it("waits for projectile custody terminals before aborted-duel loadout cleanup", async () => {
    const fixture = createCompetitiveFixture({});
    let releaseCustody!: () => void;
    const custodyGate = new Promise<void>((resolve) => {
      releaseCustody = resolve;
    });
    fixture.waitForProjectileCustodySettlements.mockImplementation(
      async () => custodyGate,
    );
    const cleanupAgentCombatSetup = vi.fn(async () => {});
    const removeDuelFood = vi.fn(async () => {});
    const internals = fixture.orchestrator as unknown as {
      cleanupAgentCombatSetup(playerId: string): Promise<void>;
      removeDuelFood(
        playerId: string,
        trackedSlots: readonly unknown[],
      ): Promise<void>;
    };
    internals.cleanupAgentCombatSetup = cleanupAgentCombatSetup;
    internals.removeDuelFood = removeDuelFood;

    const cleanup = fixture.orchestrator.cleanupAfterAbort(
      fixture.cycle as never,
    );
    await vi.waitFor(() => {
      expect(fixture.forceEndCombat).toHaveBeenCalledTimes(2);
      expect(fixture.waitForProjectileCustodySettlements).toHaveBeenCalledTimes(
        2,
      );
    });
    expect(cleanupAgentCombatSetup).not.toHaveBeenCalled();
    expect(removeDuelFood).not.toHaveBeenCalled();

    releaseCustody();
    await cleanup;

    expect(cleanupAgentCombatSetup).toHaveBeenCalledTimes(2);
    expect(removeDuelFood).toHaveBeenCalledTimes(2);
  });

  it("freezes exact owned melee, ranged, and magic alternatives for bettors", () => {
    const fixture = createCompetitiveFixture({
      alphaInventory: [
        { slot: 0, itemId: "shortbow", quantity: 1 },
        { slot: 1, itemId: "bronze_arrow", quantity: 50 },
        { slot: 2, itemId: "staff_of_air", quantity: 1 },
        { slot: 3, itemId: "mind_rune", quantity: 20 },
      ],
    });

    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );

    expect(frozen).toMatchObject({
      ok: true,
      initialCombatRole: "melee",
      availableCombatStyles: ["melee", "ranged", "mage"],
      combatLoadouts: {
        melee: {
          role: "melee",
          weaponId: "launch_test_blade",
          arrowsId: null,
          shieldId: null,
          spellId: null,
        },
        ranged: {
          role: "ranged",
          weaponId: "shortbow",
          arrowsId: "bronze_arrow",
          shieldId: null,
          spellId: null,
        },
        mage: {
          role: "mage",
          weaponId: "staff_of_air",
          arrowsId: null,
          shieldId: null,
          spellId: "wind_strike",
        },
      },
    });
    expect(fixture.agent1.combatLoadouts).toEqual(
      frozen.ok ? frozen.combatLoadouts : {},
    );
  });

  it("freezes exact owned shield and armor sets for alternate roles", () => {
    const fixture = createCompetitiveFixture({
      alphaWeapon: "shortbow",
      alphaArrows: { itemId: "bronze_arrow", quantity: 50 },
      alphaBody: "launch_test_ranged_body",
      alphaInventory: [
        { slot: 0, itemId: "launch_test_blade", quantity: 1 },
        { slot: 1, itemId: "launch_test_shield", quantity: 1 },
        { slot: 2, itemId: "launch_test_melee_body", quantity: 1 },
      ],
    });

    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );

    expect(frozen).toMatchObject({
      ok: true,
      initialCombatRole: "ranged",
      availableCombatStyles: ["melee", "ranged"],
      combatLoadouts: {
        melee: {
          role: "melee",
          weaponId: "launch_test_blade",
          arrowsId: null,
          shieldId: "launch_test_shield",
          spellId: null,
          armorIds: expect.objectContaining({
            body: "launch_test_melee_body",
          }),
        },
        ranged: {
          role: "ranged",
          weaponId: "shortbow",
          arrowsId: "bronze_arrow",
          shieldId: null,
          spellId: null,
          armorIds: expect.objectContaining({
            body: "launch_test_ranged_body",
          }),
        },
      },
    });
  });

  it("authorizes an in-fight switch only from the exact frozen loadout map", async () => {
    const fixture = createCompetitiveFixture({
      alphaInventory: [
        { slot: 0, itemId: "shortbow", quantity: 1 },
        { slot: 1, itemId: "bronze_arrow", quantity: 50 },
      ],
    });
    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );
    if (!frozen.ok) throw new Error(frozen.reason);
    fixture.cycle.phase = "FIGHTING";
    (
      fixture.entities.get(fixture.ids[0])!.data as Record<string, unknown>
    ).inStreamingDuel = true;
    const switchRole = (
      fixture.orchestrator as unknown as {
        switchFrozenCombatRole: (
          cycleId: string,
          playerId: string,
          role: "ranged",
          operationId: string,
        ) => Promise<{ ok: boolean; retryable: boolean }>;
      }
    ).switchFrozenCombatRole.bind(fixture.orchestrator);

    await expect(
      switchRole(
        "competitive-cycle",
        fixture.ids[0],
        "ranged",
        `combat-loadout:competitive-cycle:${fixture.ids[0]}:1`,
      ),
    ).resolves.toMatchObject({ ok: true, retryable: false });
    expect(fixture.switchOwnedCombatLoadout).toHaveBeenCalledOnce();
    expect(fixture.switchOwnedCombatLoadout).toHaveBeenCalledWith(
      fixture.ids[0],
      expect.objectContaining({
        operationId: `combat-loadout:competitive-cycle:${fixture.ids[0]}:1`,
        targetRole: "ranged",
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        allowedLoadouts: frozen.combatLoadouts,
      }),
    );
    expect(fixture.entities.get(fixture.ids[0])!.data).toMatchObject({
      streamingDuelCombatRole: "ranged",
      streamingDuelWeaponId: "shortbow",
    });
  });

  it("defers a frozen switch until the committed pair projectile resolves", async () => {
    const fixture = createCompetitiveFixture({
      alphaInventory: [
        { slot: 0, itemId: "shortbow", quantity: 1 },
        { slot: 1, itemId: "bronze_arrow", quantity: 50 },
      ],
      activePairProjectile: true,
    });
    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );
    if (!frozen.ok) throw new Error(frozen.reason);
    fixture.cycle.phase = "FIGHTING";
    const switchRole = (
      fixture.orchestrator as unknown as {
        switchFrozenCombatRole: (
          cycleId: string,
          playerId: string,
          role: "ranged",
          operationId: string,
        ) => Promise<{ ok: boolean; retryable: boolean; reason?: string }>;
      }
    ).switchFrozenCombatRole.bind(fixture.orchestrator);

    await expect(
      switchRole(
        "competitive-cycle",
        fixture.ids[0],
        "ranged",
        `combat-loadout:competitive-cycle:${fixture.ids[0]}:1`,
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      reason: "attack_in_flight",
    });
    expect(fixture.hasActiveProjectilesBetween).toHaveBeenCalledWith(
      fixture.ids[0],
      fixture.ids[1],
    );
    expect(fixture.quiesceAutoAttacksBetween).toHaveBeenCalledWith(
      fixture.ids[0],
      fixture.ids[1],
    );
    expect(fixture.switchOwnedCombatLoadout).not.toHaveBeenCalled();
  });

  it("fails a frozen switch closed when projectile quiescence is unavailable", async () => {
    const fixture = createCompetitiveFixture({
      alphaInventory: [
        { slot: 0, itemId: "shortbow", quantity: 1 },
        { slot: 1, itemId: "bronze_arrow", quantity: 50 },
      ],
      activePairProjectile: true,
    });
    fixture.quiesceAutoAttacksBetween.mockReturnValue(false);
    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );
    if (!frozen.ok) throw new Error(frozen.reason);
    fixture.cycle.phase = "FIGHTING";
    const switchRole = (
      fixture.orchestrator as unknown as {
        switchFrozenCombatRole: (
          cycleId: string,
          playerId: string,
          role: "ranged",
          operationId: string,
        ) => Promise<{ ok: boolean; retryable: boolean; reason?: string }>;
      }
    ).switchFrozenCombatRole.bind(fixture.orchestrator);

    await expect(
      switchRole(
        "competitive-cycle",
        fixture.ids[0],
        "ranged",
        `combat-loadout:competitive-cycle:${fixture.ids[0]}:1`,
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      reason: "attack_quiesce_unavailable",
    });
    expect(fixture.switchOwnedCombatLoadout).not.toHaveBeenCalled();
  });

  it("permits exact frozen multi-style switching only inside the no-money diagnostic boundary", async () => {
    const environment = {
      NODE_ENV: "production",
      DUEL_LOCAL_SMOKE_MODE: "true",
      LOAD_TEST_MODE: "true",
      DUEL_BETTING_ENABLED: "false",
      DUEL_WITH_HYPERBET: "false",
      STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      PUBLIC_API_URL: "http://127.0.0.1:35551",
      PUBLIC_WS_URL: "ws://localhost:35552/ws",
    } as const;
    const previous = new Map(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);

    try {
      const fixture = createCompetitiveFixture({ synthetic: true });
      (
        fixture.orchestrator as unknown as {
          setDiagnosticMultiStyleAllowed: (
            playerId: string,
            allowed: boolean,
          ) => void;
        }
      ).setDiagnosticMultiStyleAllowed(fixture.ids[0], true);
      fixture.orchestrator.setDebugCombatRoleOverride(fixture.ids[0], "melee");

      const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
        fixture.agent1,
      );
      if (!frozen.ok) throw new Error(frozen.reason);
      expect(frozen).toMatchObject({
        ok: true,
        diagnostic: true,
        initialCombatRole: "melee",
        availableCombatStyles: ["melee", "ranged", "mage"],
        combatLoadouts: {
          melee: { role: "melee", weaponId: "bronze_shortsword" },
          ranged: {
            role: "ranged",
            weaponId: "shortbow",
            arrowsId: "bronze_arrow",
          },
          mage: {
            role: "mage",
            weaponId: "staff_of_air",
            spellId: "wind_strike",
          },
        },
      });
      expect(fixture.agent1.loadoutFrozen).toBe(true);

      fixture.cycle.phase = "FIGHTING";
      const switchRole = (
        fixture.orchestrator as unknown as {
          switchFrozenCombatRole: (
            cycleId: string,
            playerId: string,
            role: "ranged" | "mage",
            operationId: string,
          ) => Promise<{ ok: boolean; retryable: boolean }>;
        }
      ).switchFrozenCombatRole.bind(fixture.orchestrator);
      await expect(
        switchRole(
          "competitive-cycle",
          fixture.ids[0],
          "ranged",
          `combat-loadout:competitive-cycle:${fixture.ids[0]}:1`,
        ),
      ).resolves.toEqual({ ok: true, retryable: false, replayed: false });
      expect(fixture.switchOwnedCombatLoadout).toHaveBeenCalledWith(
        fixture.ids[0],
        expect.objectContaining({
          targetRole: "ranged",
          allowedLoadouts: frozen.ok ? frozen.combatLoadouts : {},
        }),
      );

      process.env.DUEL_BETTING_ENABLED = "true";
      await expect(
        switchRole(
          "competitive-cycle",
          fixture.ids[0],
          "mage",
          `combat-loadout:competitive-cycle:${fixture.ids[0]}:2`,
        ),
      ).resolves.toEqual({
        ok: false,
        retryable: false,
        reason: "orchestrator_boundary_rejected",
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("tracks the synthetic opening weapon so repeated diagnostics cannot mint copies", async () => {
    const environment = {
      NODE_ENV: "production",
      DUEL_LOCAL_SMOKE_MODE: "true",
      LOAD_TEST_MODE: "true",
      DUEL_BETTING_ENABLED: "false",
      DUEL_WITH_HYPERBET: "false",
      STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      PUBLIC_API_URL: "http://127.0.0.1:35551",
      PUBLIC_WS_URL: "ws://localhost:35552/ws",
    } as const;
    const previous = new Map(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);

    try {
      const fixture = createCompetitiveFixture({ synthetic: true });
      fixture.orchestrator.setDebugCombatRoleOverride(fixture.ids[0], "melee");
      (
        fixture.orchestrator as unknown as {
          setDiagnosticMultiStyleAllowed: (
            playerId: string,
            allowed: boolean,
          ) => void;
        }
      ).setDiagnosticMultiStyleAllowed(fixture.ids[0], true);
      const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
        fixture.agent1,
      );
      if (!frozen.ok) throw new Error(frozen.reason);

      fixture.equipItemDirect.mockImplementation(
        async (playerId: string, itemId: string, quantity = 1) => {
          const playerEquipment = fixture.equipment.get(
            playerId as (typeof fixture.ids)[number],
          )!;
          if (itemId === "bronze_arrow") {
            playerEquipment.arrows = {
              itemId,
              item: { id: itemId },
              quantity,
            };
          } else {
            playerEquipment.weapon = {
              itemId,
              item: { id: itemId },
              quantity,
            };
          }
          return { success: true, displacedItems: [] };
        },
      );
      fixture.addItemDirect.mockImplementation(
        async (
          playerId: string,
          item: { itemId: string; quantity: number },
        ) => {
          const inventory = fixture.inventories.get(
            playerId as (typeof fixture.ids)[number],
          )!;
          const nextSlot =
            inventory.items.reduce(
              (max, existing) => Math.max(max, existing.slot),
              -1,
            ) + 1;
          inventory.items.push({ slot: nextSlot, ...item });
          return true;
        },
      );

      await (
        fixture.orchestrator as unknown as {
          ensureDiagnosticMultiStyleCombatSetup: (
            playerId: string,
            openingRole: "melee",
            loadouts: Record<string, unknown>,
          ) => Promise<string>;
        }
      ).ensureDiagnosticMultiStyleCombatSetup(
        fixture.ids[0],
        "melee",
        frozen.combatLoadouts,
      );

      const snapshot = (
        fixture.orchestrator as unknown as {
          combatSetupSnapshotsByAgent: Map<
            string,
            { provisionedItemIds: Set<string> }
          >;
        }
      ).combatSetupSnapshotsByAgent.get(fixture.ids[0]);
      expect(snapshot?.provisionedItemIds).toContain("bronze_shortsword");

      // Model a live switch away from the synthetic opening weapon. The
      // atomic loadout operation returns the opening weapon to inventory and
      // debits the target staff from it.
      const inventory = fixture.inventories.get(fixture.ids[0])!;
      const staffIndex = inventory.items.findIndex(
        (item) => item.itemId === "staff_of_air",
      );
      expect(staffIndex).toBeGreaterThanOrEqual(0);
      inventory.items.splice(staffIndex, 1);
      inventory.items.push({
        slot:
          inventory.items.reduce(
            (max, existing) => Math.max(max, existing.slot),
            -1,
          ) + 1,
        itemId: "bronze_shortsword",
        quantity: 1,
      });
      fixture.equipment.get(fixture.ids[0])!.weapon = {
        itemId: "staff_of_air",
        item: { id: "staff_of_air" },
        quantity: 1,
      };

      await fixture.orchestrator.cleanupAgentCombatSetup(fixture.ids[0]);

      expect(fixture.inventories.get(fixture.ids[0])!.items).toEqual([]);
      expect(fixture.equipment.get(fixture.ids[0])!.weapon.itemId).toBe(
        "launch_test_blade",
      );
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects post-market roles and operation IDs outside the frozen authority", async () => {
    const fixture = createCompetitiveFixture();
    const frozen = fixture.orchestrator.freezeCompetitiveLoadout(
      fixture.agent1,
    );
    if (!frozen.ok) throw new Error(frozen.reason);
    fixture.cycle.phase = "FIGHTING";
    const switchRole = (
      fixture.orchestrator as unknown as {
        switchFrozenCombatRole: (
          cycleId: string,
          playerId: string,
          role: "ranged",
          operationId: string,
        ) => Promise<{ ok: boolean; retryable: boolean }>;
      }
    ).switchFrozenCombatRole.bind(fixture.orchestrator);

    await expect(
      switchRole(
        "competitive-cycle",
        fixture.ids[0],
        "ranged",
        `combat-loadout:competitive-cycle:${fixture.ids[0]}:1`,
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      reason: "orchestrator_boundary_rejected",
    });
    await expect(
      switchRole(
        "competitive-cycle",
        fixture.ids[0],
        "ranged",
        "forged-operation-id",
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      reason: "orchestrator_boundary_rejected",
    });
    expect(fixture.switchOwnedCombatLoadout).not.toHaveBeenCalled();
  });

  it("rejects unprepared and rune-starved contestants", () => {
    const unarmed = createCompetitiveFixture({ alphaWeapon: null });
    expect(
      unarmed.orchestrator.inspectCompetitiveLoadout(unarmed.ids[0]),
    ).toEqual({ ok: false, reason: "equipped_combat_weapon_missing" });

    const runeStarved = createCompetitiveFixture({
      alphaWeapon: "staff_of_air",
      alphaSpell: "wind_strike",
      alphaInventory: [],
    });
    expect(
      runeStarved.orchestrator.inspectCompetitiveLoadout(runeStarved.ids[0]),
    ).toEqual({ ok: false, reason: "selected_spell_runes_missing" });
  });

  it("rejects unsupported visible equipment before a public market can open", () => {
    const unsupportedWeapon = createCompetitiveFixture({
      alphaWeapon: "bronze_dagger",
      alphaHelmet: null,
      useProductionPresentationGate: true,
    });
    expect(
      unsupportedWeapon.orchestrator.inspectCompetitiveLoadout(
        unsupportedWeapon.ids[0],
      ),
    ).toEqual({
      ok: false,
      reason: "equipment_presentation_not_certified:weapon:bronze_dagger",
    });

    const unsupportedArmor = createCompetitiveFixture({
      alphaWeapon: "bronze_shortsword",
      alphaHelmet: "bronze_full_helm",
      useProductionPresentationGate: true,
    });
    expect(
      unsupportedArmor.orchestrator.inspectCompetitiveLoadout(
        unsupportedArmor.ids[0],
      ),
    ).toEqual({
      ok: false,
      reason: "equipment_presentation_not_certified:helmet:bronze_full_helm",
    });
  });

  it("accepts an owned magic setup only when the frozen runes are sufficient", () => {
    const fixture = createCompetitiveFixture({
      alphaWeapon: "staff_of_air",
      alphaSpell: "wind_strike",
      alphaInventory: [{ slot: 0, itemId: "mind_rune", quantity: 5 }],
    });

    expect(
      fixture.orchestrator.inspectCompetitiveLoadout(fixture.ids[0]),
    ).toMatchObject({
      ok: true,
      diagnostic: false,
      initialCombatRole: "mage",
      availableCombatStyles: expect.arrayContaining(["mage"]),
    });
    const inspected = fixture.orchestrator.inspectCompetitiveLoadout(
      fixture.ids[0],
    );
    expect(inspected.ok && inspected.availableCombatStyles).not.toContain(
      "melee",
    );
  });

  it("rejects ranged loadouts with missing or incompatible ammunition", () => {
    const noArrows = createCompetitiveFixture({ alphaWeapon: "shortbow" });
    expect(
      noArrows.orchestrator.inspectCompetitiveLoadout(noArrows.ids[0]),
    ).toEqual({ ok: false, reason: "equipped_arrows_missing" });

    const incompatible = createCompetitiveFixture({
      alphaWeapon: "shortbow",
      alphaArrows: { itemId: "rune_arrow", quantity: 20 },
    });
    expect(
      incompatible.orchestrator.inspectCompetitiveLoadout(incompatible.ids[0]),
    ).toEqual({
      ok: false,
      reason: "equipped_arrows_incompatible_arrows",
    });
  });

  it("fails closed on inventory drift after market open without provisioning", async () => {
    const fixture = createCompetitiveFixture({
      alphaInventory: [{ slot: 0, itemId: "cooked_fish", quantity: 3 }],
    });
    expect(
      fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent1).ok,
    ).toBe(true);
    expect(
      fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent2).ok,
    ).toBe(true);
    fixture.inventories.get(fixture.ids[0])!.items[0]!.quantity = 2;

    await expect(
      fixture.orchestrator.prepareContestantsForDuel(),
    ).rejects.toThrow("competitive_loadout_changed_after_market_open");
    expect(fixture.equipItemDirect).not.toHaveBeenCalled();
    expect(fixture.addItemDirect).not.toHaveBeenCalled();
    expect(fixture.restorePrayerPoints).not.toHaveBeenCalled();
  });

  it("fails closed when armor or combat skills drift after market open", async () => {
    const fixture = createCompetitiveFixture();
    fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent1);
    fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent2);
    fixture.equipment.get(fixture.ids[0])!.helmet = {
      itemId: null,
      item: null,
    };
    (
      fixture.entities.get(fixture.ids[1])!.data.skills as Record<
        string,
        { level: number }
      >
    ).strength.level = 41;

    await expect(
      fixture.orchestrator.prepareContestantsForDuel(),
    ).rejects.toThrow("competitive_loadout_changed_after_market_open");
  });

  it("prepares real contestants without equipping or adding any item", async () => {
    const fixture = createCompetitiveFixture();
    fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent1);
    fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent2);

    await fixture.orchestrator.prepareContestantsForDuel();

    expect(fixture.equipItemDirect).not.toHaveBeenCalled();
    expect(fixture.addItemDirect).not.toHaveBeenCalled();
  });

  it("never restores consumed competitive ammunition during cleanup", async () => {
    const fixture = createCompetitiveFixture({
      alphaWeapon: "shortbow",
      alphaArrows: { itemId: "bronze_arrow", quantity: 10 },
    });
    expect(
      fixture.orchestrator.freezeCompetitiveLoadout(fixture.agent1).ok,
    ).toBe(true);
    fixture.equipment.get(fixture.ids[0])!.arrows.quantity = 9;

    await fixture.orchestrator.cleanupAgentCombatSetup(fixture.ids[0]);

    expect(fixture.equipment.get(fixture.ids[0])!.arrows.quantity).toBe(9);
    expect(fixture.equipItemDirect).not.toHaveBeenCalled();
  });

  it("rejects synthetic diagnostic contestants in production", () => {
    const fixture = createCompetitiveFixture({ synthetic: true });
    expect(
      fixture.orchestrator.inspectCompetitiveLoadout(fixture.ids[0]),
    ).toEqual({
      ok: false,
      reason: "synthetic_diagnostic_contestant_disabled_in_production",
    });
  });

  it("allows a registered synthetic contestant only inside the complete local smoke boundary", () => {
    const overrides = {
      DUEL_LOCAL_SMOKE_MODE: "true",
      LOAD_TEST_MODE: "true",
      DUEL_BETTING_ENABLED: "false",
      DUEL_WITH_HYPERBET: "false",
      STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      PUBLIC_API_URL: "http://127.0.0.1:35551",
      PUBLIC_WS_URL: "ws://127.0.0.1:35552/ws",
    };
    const originalValues = Object.fromEntries(
      Object.keys(overrides).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, overrides);
    try {
      const fixture = createCompetitiveFixture({ synthetic: true });
      expect(
        fixture.orchestrator.inspectCompetitiveLoadout(fixture.ids[0]),
      ).toMatchObject({ ok: true, diagnostic: true });
    } finally {
      for (const [name, value] of Object.entries(originalValues)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
