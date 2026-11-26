import { describe, it, expect } from "vitest";
import {
  deriveStreamingDuelEquipmentVisualContract,
  deriveStreamingRendererHealth,
  getStreamingPreparationVisualFingerprint,
  getStreamingFailurePresentation,
  parseStreamingBettingConfig,
  shouldDismissStreamingLoading,
} from "../../../src/screens/StreamingMode";
import type { StreamingState } from "../../../src/screens/StreamingMode";

describe("getStreamingPreparationVisualFingerprint", () => {
  it("ignores diagnostic timestamps but reacts to viewer-visible activity", () => {
    const createDiagnostics = (
      updatedAt: number,
      phase: "striking" | "recovering",
    ) => ({
      schemaVersion: 1 as const,
      updatedAt,
      activeCount: 1,
      readyCount: 1,
      ready: true,
      players: [
        {
          playerId: "agent-a",
          presentationActive: true,
          gatheringToolItemId: "harpoon",
          fishingPhase: phase,
          desiredItemId: "harpoon",
          attachedItemId: "harpoon",
          heldVisualPresent: true,
          heldVisualVisible: true,
          worldVisualPresent: false,
          worldVisualVisible: false,
          attachedToCurrentAvatar: true,
          gatheringRevision: 1,
          fishingRevision: 1,
          ready: true,
        },
      ],
    });

    expect(
      getStreamingPreparationVisualFingerprint(
        createDiagnostics(1_000, "striking"),
      ),
    ).toBe(
      getStreamingPreparationVisualFingerprint(
        createDiagnostics(2_000, "striking"),
      ),
    );
    expect(
      getStreamingPreparationVisualFingerprint(
        createDiagnostics(2_000, "recovering"),
      ),
    ).not.toBe(
      getStreamingPreparationVisualFingerprint(
        createDiagnostics(2_000, "striking"),
      ),
    );
    expect(getStreamingPreparationVisualFingerprint(null)).toBe("inactive");
  });
});

describe("deriveStreamingDuelEquipmentVisualContract", () => {
  it("prewarms every visible frozen role item and declares exact current slots", () => {
    const state = {
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "cycle-visuals",
        phase: "ANNOUNCEMENT",
        agent1: {
          id: "agent-a",
          loadoutFrozen: true,
          equipment: {
            weapon: "staff_of_air",
            body: "wizard_robe_top",
            legs: "wizard_robe_bottom",
            amulet: "amulet_of_power",
            ring: "seers_ring",
          },
          combatLoadouts: {
            melee: {
              role: "melee",
              weaponId: "bronze_shortsword",
              shieldId: "bronze_kiteshield",
              arrowsId: null,
              spellId: null,
              armorIds: {
                helmet: "bronze_full_helm",
                body: "bronze_platebody",
                legs: "bronze_platelegs",
                boots: "bronze_boots",
                gloves: "bronze_gloves",
                cape: "cape",
                amulet: "amulet_of_strength",
                ring: "warrior_ring",
              },
            },
            ranged: {
              role: "ranged",
              weaponId: "shortbow",
              shieldId: null,
              arrowsId: "iron_arrow",
              spellId: null,
              armorIds: {
                helmet: "leather_cowl",
                body: "leather_body",
                legs: "leather_chaps",
                boots: "leather_boots",
                gloves: "leather_vambraces",
                cape: "cape",
                amulet: "amulet_of_accuracy",
                ring: "archers_ring",
              },
            },
            mage: {
              role: "mage",
              weaponId: "staff_of_air",
              shieldId: null,
              arrowsId: null,
              spellId: "wind_strike",
              armorIds: {
                helmet: "wizard_hat",
                body: "wizard_robe_top",
                legs: "wizard_robe_bottom",
                boots: "wizard_boots",
                gloves: null,
                cape: "cape",
                amulet: "amulet_of_power",
                ring: "seers_ring",
              },
            },
          },
        },
        agent2: null,
      },
    } as unknown as StreamingState;

    const contract = deriveStreamingDuelEquipmentVisualContract(state);
    expect(contract.cycleId).toBe("cycle-visuals");
    expect(contract.requirements).toEqual(
      expect.arrayContaining([
        {
          playerId: "agent-a",
          slot: "weapon",
          itemId: "bronze_shortsword",
        },
        { playerId: "agent-a", slot: "weapon", itemId: "shortbow" },
        { playerId: "agent-a", slot: "weapon", itemId: "staff_of_air" },
        {
          playerId: "agent-a",
          slot: "shield",
          itemId: "bronze_kiteshield",
        },
        {
          playerId: "agent-a",
          slot: "body",
          itemId: "bronze_platebody",
        },
        { playerId: "agent-a", slot: "body", itemId: "leather_body" },
        {
          playerId: "agent-a",
          slot: "body",
          itemId: "wizard_robe_top",
        },
        { playerId: "agent-a", slot: "cape", itemId: "cape" },
      ]),
    );
    expect(contract.requirements).not.toEqual(
      expect.arrayContaining([
        { playerId: "agent-a", slot: "arrows", itemId: "iron_arrow" },
        {
          playerId: "agent-a",
          slot: "amulet",
          itemId: "amulet_of_power",
        },
        { playerId: "agent-a", slot: "ring", itemId: "seers_ring" },
      ]),
    );
    expect(contract.currentEquipment).toHaveLength(8);
    expect(contract.currentEquipment).toContainEqual({
      playerId: "agent-a",
      slot: "body",
      itemId: "wizard_robe_top",
    });
    expect(contract.currentEquipment).toContainEqual({
      playerId: "agent-a",
      slot: "shield",
      itemId: null,
    });
  });

  it("keeps identical frozen items player-specific for fit validation", () => {
    const contestant = (id: string) => ({
      id,
      loadoutFrozen: true,
      equipment: { weapon: "bronze_shortsword" },
      combatLoadouts: {
        melee: {
          role: "melee",
          weaponId: "bronze_shortsword",
          shieldId: null,
          arrowsId: null,
          spellId: null,
          armorIds: {},
        },
      },
    });
    const state = {
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "cycle-two-avatars",
        agent1: contestant("agent-a"),
        agent2: contestant("agent-b"),
      },
    } as unknown as StreamingState;

    expect(
      deriveStreamingDuelEquipmentVisualContract(state).requirements,
    ).toEqual([
      {
        playerId: "agent-a",
        slot: "weapon",
        itemId: "bronze_shortsword",
      },
      {
        playerId: "agent-b",
        slot: "weapon",
        itemId: "bronze_shortsword",
      },
    ]);
  });

  it("requires current visible equipment for unfrozen no-money diagnostics", () => {
    const state = {
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "cycle-diagnostic-visuals",
        agent1: {
          id: "diagnostic-melee",
          loadoutFrozen: false,
          equipment: { weapon: "bronze_2h_sword" },
          combatLoadouts: {},
        },
        agent2: {
          id: "diagnostic-ranged",
          loadoutFrozen: false,
          equipment: {
            weapon: "magic_shortbow",
            arrows: "rune_arrow",
          },
          combatLoadouts: {},
        },
      },
    } as unknown as StreamingState;

    const contract = deriveStreamingDuelEquipmentVisualContract(state);
    expect(contract.requirements).toEqual([
      {
        playerId: "diagnostic-melee",
        slot: "weapon",
        itemId: "bronze_2h_sword",
      },
      {
        playerId: "diagnostic-ranged",
        slot: "weapon",
        itemId: "magic_shortbow",
      },
    ]);
    expect(contract.currentEquipment).toHaveLength(16);
    expect(contract.currentEquipment).toContainEqual({
      playerId: "diagnostic-ranged",
      slot: "weapon",
      itemId: "magic_shortbow",
    });
  });

  it("does not let uncertified exploration gear block the private IDLE preparation view", () => {
    const state = {
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "",
        phase: "IDLE",
        agent1: {
          id: "ordinary-a",
          loadoutFrozen: false,
          equipment: {
            weapon: "bronze_dagger",
            helmet: "bronze_full_helm",
          },
          combatLoadouts: {},
        },
        agent2: {
          id: "ordinary-b",
          loadoutFrozen: false,
          equipment: { boots: "leather_boots" },
          combatLoadouts: {},
        },
      },
    } as unknown as StreamingState;

    expect(deriveStreamingDuelEquipmentVisualContract(state)).toEqual({
      cycleId: "",
      requirements: [],
      currentEquipment: [],
    });
  });
});

describe("parseStreamingBettingConfig", () => {
  it("accepts the server-owned readiness envelope", () => {
    expect(
      parseStreamingBettingConfig({
        configured: true,
        betUrl: " https://bet.example/duels ",
        bettingBridgeEnabled: true,
        ready: true,
        unavailableReason: null,
        checkedAt: 100,
        hint: "Pick a side",
      }),
    ).toEqual({
      configured: true,
      betUrl: "https://bet.example/duels",
      bettingBridgeEnabled: true,
      ready: true,
      unavailableReason: null,
      checkedAt: 100,
      hint: "Pick a side",
    });
  });

  it("rejects stale legacy or malformed envelopes", () => {
    expect(
      parseStreamingBettingConfig({
        configured: true,
        betUrl: "https://bet.example/duels",
        bettingBridgeEnabled: true,
      }),
    ).toBeNull();
    expect(
      parseStreamingBettingConfig({
        configured: true,
        betUrl: "https://bet.example/duels",
        bettingBridgeEnabled: true,
        ready: "yes",
        unavailableReason: null,
        checkedAt: 100,
      }),
    ).toBeNull();
  });
});

describe("getStreamingFailurePresentation", () => {
  it("turns a bounded boot timeout into actionable viewer copy", () => {
    expect(
      getStreamingFailurePresentation(
        "Stream setup timed out before the arena became ready.",
      ),
    ).toEqual({
      title: "Arena took too long to load",
      detail:
        "The live world did not become ready in time. The stream can be retried safely.",
    });
  });

  it("distinguishes renderer and asset failures", () => {
    expect(getStreamingFailurePresentation("WebGPU is required").title).toBe(
      "Browser graphics unavailable",
    );
    expect(
      getStreamingFailurePresentation("HTTP error! status: 404").title,
    ).toBe("Stream assets unavailable");
  });
});

describe("shouldDismissStreamingLoading", () => {
  it("keeps the overlay up until the world is ready", () => {
    expect(
      shouldDismissStreamingLoading({
        connected: true,
        worldReady: false,
        terrainReady: true,
        sceneAssetsReady: true,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: false,
        cameraLocked: false,
        phase: "ANNOUNCEMENT",
      }),
    ).toBe(false);
  });

  it("keeps the overlay up until the camera is locked when required", () => {
    expect(
      shouldDismissStreamingLoading({
        connected: true,
        worldReady: true,
        terrainReady: true,
        sceneAssetsReady: true,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: true,
        cameraLocked: false,
        phase: "FIGHTING",
      }),
    ).toBe(false);
  });

  it("keeps the overlay up while disconnected", () => {
    expect(
      shouldDismissStreamingLoading({
        connected: false,
        worldReady: true,
        terrainReady: true,
        sceneAssetsReady: true,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: false,
        cameraLocked: false,
        phase: "COUNTDOWN",
      }),
    ).toBe(false);
  });

  it("keeps the overlay up until terrain is ready", () => {
    expect(
      shouldDismissStreamingLoading({
        connected: true,
        worldReady: true,
        terrainReady: false,
        sceneAssetsReady: true,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: false,
        cameraLocked: false,
        phase: "COUNTDOWN",
      }),
    ).toBe(false);
  });

  it("keeps the overlay up when the client is in an active duel without streaming state", () => {
    expect(
      shouldDismissStreamingLoading({
        connected: true,
        worldReady: true,
        terrainReady: true,
        sceneAssetsReady: true,
        hasStreamingState: false,
        initError: null,
        needsCameraLock: false,
        cameraLocked: false,
        phase: "FIGHTING",
      }),
    ).toBe(false);
  });

  it("keeps the overlay up until the arena and contestant models are ready", () => {
    expect(
      shouldDismissStreamingLoading({
        connected: true,
        worldReady: true,
        terrainReady: true,
        sceneAssetsReady: false,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: false,
        cameraLocked: false,
        phase: "ANNOUNCEMENT",
      }),
    ).toBe(false);
  });

  it("marks a live duel as degraded while the loading overlay is still visible", () => {
    expect(
      deriveStreamingRendererHealth({
        connected: true,
        worldReady: true,
        terrainReady: true,
        sceneAssetsReady: true,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: true,
        cameraLocked: true,
        loadingDismissed: false,
        phase: "FIGHTING",
        agent1: {
          id: "a",
          name: "Agent A",
          provider: "provider",
          model: "model",
          hp: 10,
          maxHp: 10,
          combatLevel: 1,
          wins: 0,
          losses: 0,
          damageDealtThisFight: 0,
          highestHit: 0,
          attacksLanded: 0,
          healsUsed: 0,
          equipment: {},
          inventory: [],
          rank: 1,
          headToHeadWins: 0,
          headToHeadLosses: 0,
        },
        agent2: {
          id: "b",
          name: "Agent B",
          provider: "provider",
          model: "model",
          hp: 10,
          maxHp: 10,
          combatLevel: 1,
          wins: 0,
          losses: 0,
          damageDealtThisFight: 0,
          highestHit: 0,
          attacksLanded: 0,
          healsUsed: 0,
          equipment: {},
          inventory: [],
          rank: 2,
          headToHeadWins: 0,
          headToHeadLosses: 0,
        },
        arenaPositions: {
          agent1: [1, 0, 1],
          agent2: [3, 0, 3],
        },
      }).degradedReason,
    ).toBe("loading_overlay_active");
  });

  it("marks overlapping arena positions as unhealthy", () => {
    expect(
      deriveStreamingRendererHealth({
        connected: true,
        worldReady: true,
        terrainReady: true,
        sceneAssetsReady: true,
        hasStreamingState: true,
        initError: null,
        needsCameraLock: false,
        cameraLocked: false,
        loadingDismissed: true,
        phase: "COUNTDOWN",
        agent1: {
          id: "a",
          name: "Agent A",
          provider: "provider",
          model: "model",
          hp: 10,
          maxHp: 10,
          combatLevel: 1,
          wins: 0,
          losses: 0,
          damageDealtThisFight: 0,
          highestHit: 0,
          attacksLanded: 0,
          healsUsed: 0,
          equipment: {},
          inventory: [],
          rank: 1,
          headToHeadWins: 0,
          headToHeadLosses: 0,
        },
        agent2: {
          id: "b",
          name: "Agent B",
          provider: "provider",
          model: "model",
          hp: 10,
          maxHp: 10,
          combatLevel: 1,
          wins: 0,
          losses: 0,
          damageDealtThisFight: 0,
          highestHit: 0,
          attacksLanded: 0,
          healsUsed: 0,
          equipment: {},
          inventory: [],
          rank: 2,
          headToHeadWins: 0,
          headToHeadLosses: 0,
        },
        arenaPositions: {
          agent1: [2, 0, 2],
          agent2: [2, 0, 2],
        },
      }).degradedReason,
    ).toBe("arena_positions_invalid");
  });

  it("keeps announcement readiness fail-closed until arena handoff is authoritative", () => {
    const base = {
      connected: true,
      worldReady: true,
      terrainReady: true,
      sceneAssetsReady: true,
      hasStreamingState: true,
      initError: null,
      needsCameraLock: false,
      cameraLocked: false,
      loadingDismissed: true,
      phase: "ANNOUNCEMENT" as const,
      agent1: {
        id: "a",
        name: "Agent A",
        provider: "provider",
        model: "model",
        hp: 10,
        maxHp: 10,
        combatLevel: 1,
        wins: 0,
        losses: 0,
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        equipment: {},
        inventory: [],
        rank: 1,
        headToHeadWins: 0,
        headToHeadLosses: 0,
      },
      agent2: {
        id: "b",
        name: "Agent B",
        provider: "provider",
        model: "model",
        hp: 10,
        maxHp: 10,
        combatLevel: 1,
        wins: 0,
        losses: 0,
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        equipment: {},
        inventory: [],
        rank: 2,
        headToHeadWins: 0,
        headToHeadLosses: 0,
      },
    };

    expect(
      deriveStreamingRendererHealth({
        ...base,
        arenaPositions: null,
      }).degradedReason,
    ).toBe("arena_positions_invalid");
    expect(
      deriveStreamingRendererHealth({
        ...base,
        arenaPositions: {
          agent1: [2, 0, 2],
          agent2: [2.1, 50, 2.1],
        },
      }).degradedReason,
    ).toBe("arena_positions_invalid");
    expect(
      deriveStreamingRendererHealth({
        ...base,
        arenaPositions: {
          agent1: [2, 0, 2],
          agent2: [3, 0, 3],
        },
      }).ready,
    ).toBe(true);
  });

  it("reports ready only after the live duel surface is sane and the overlay is gone", () => {
    const health = deriveStreamingRendererHealth({
      connected: true,
      worldReady: true,
      terrainReady: true,
      sceneAssetsReady: true,
      hasStreamingState: true,
      initError: null,
      needsCameraLock: true,
      cameraLocked: true,
      loadingDismissed: true,
      phase: "FIGHTING",
      agent1: {
        id: "a",
        name: "Agent A",
        provider: "provider",
        model: "model",
        hp: 10,
        maxHp: 10,
        combatLevel: 1,
        wins: 0,
        losses: 0,
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        equipment: {},
        inventory: [],
        rank: 1,
        headToHeadWins: 0,
        headToHeadLosses: 0,
      },
      agent2: {
        id: "b",
        name: "Agent B",
        provider: "provider",
        model: "model",
        hp: 8,
        maxHp: 10,
        combatLevel: 1,
        wins: 0,
        losses: 0,
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        equipment: {},
        inventory: [],
        rank: 2,
        headToHeadWins: 0,
        headToHeadLosses: 0,
      },
      arenaPositions: {
        agent1: [1, 0, 1],
        agent2: [4, 0, 4],
      },
    });

    expect(health.ready).toBe(true);
    expect(health.degradedReason).toBeNull();
  });

  it("does not report ready during idle when streaming state is still absent", () => {
    const health = deriveStreamingRendererHealth({
      connected: true,
      worldReady: true,
      terrainReady: true,
      sceneAssetsReady: true,
      hasStreamingState: false,
      initError: null,
      needsCameraLock: false,
      cameraLocked: false,
      loadingDismissed: true,
      phase: "IDLE",
      agent1: null,
      agent2: null,
      arenaPositions: null,
    });

    expect(health.ready).toBe(false);
    expect(health.degradedReason).toBe("waiting_for_duel_data");
  });

  it("marks the stream as unhealthy when the game client reports an init error", () => {
    const health = deriveStreamingRendererHealth({
      connected: true,
      worldReady: true,
      terrainReady: true,
      sceneAssetsReady: true,
      hasStreamingState: true,
      initError: "HTTP error! status: 404",
      needsCameraLock: true,
      cameraLocked: true,
      loadingDismissed: true,
      phase: "ANNOUNCEMENT",
      agent1: {
        id: "a",
        name: "Agent A",
        provider: "provider",
        model: "model",
        hp: 10,
        maxHp: 10,
        combatLevel: 1,
        wins: 0,
        losses: 0,
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        equipment: {},
        inventory: [],
        rank: 1,
        headToHeadWins: 0,
        headToHeadLosses: 0,
      },
      agent2: {
        id: "b",
        name: "Agent B",
        provider: "provider",
        model: "model",
        hp: 10,
        maxHp: 10,
        combatLevel: 1,
        wins: 0,
        losses: 0,
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        equipment: {},
        inventory: [],
        rank: 2,
        headToHeadWins: 0,
        headToHeadLosses: 0,
      },
      arenaPositions: {
        agent1: [1, 0, 1],
        agent2: [4, 0, 4],
      },
    });

    expect(health.ready).toBe(false);
    expect(health.degradedReason).toBe("initialization_failed");
  });
});
