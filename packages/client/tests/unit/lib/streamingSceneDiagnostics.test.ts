import { describe, expect, it } from "vitest";

import {
  advanceStreamingColdRenderStability,
  advanceStreamingReadinessStability,
  areStreamingSceneAssetsReady,
  collectStreamingSceneDiagnostics,
  collectStreamingSceneReadinessEvidence,
  createStreamingColdRenderStability,
  type StreamingDiagnosticsWorld,
} from "../../../src/lib/streamingSceneDiagnostics";

type TestVector = {
  x: number;
  y: number;
  z: number;
  clone: () => TestVector & { project: () => TestVector };
};

function vector(
  x: number,
  y: number,
  z: number,
  projected: [number, number, number] = [0, 0, 0],
  projectValue?: (value: TestVector) => [number, number, number],
): TestVector {
  return {
    x,
    y,
    z,
    clone: () => {
      const clone = {
        x,
        y,
        z,
        clone: () => clone,
        project: () => {
          const next = projectValue?.(clone) ?? projected;
          clone.x = next[0];
          clone.y = next[1];
          clone.z = next[2];
          return clone;
        },
      };
      return clone;
    },
  };
}

function matrixAt(x: number, y: number, z: number) {
  const elements = Array.from({ length: 16 }, () => 0);
  elements[12] = x;
  elements[13] = y;
  elements[14] = z;
  return { elements };
}

function yaw(radians: number) {
  return {
    x: 0,
    y: Math.sin(radians / 2),
    z: 0,
    w: Math.cos(radians / 2),
  };
}

function state() {
  return {
    cycle: {
      cycleId: "cycle-1",
      phase: "FIGHTING",
      agent1: { id: "agent-a" },
      agent2: { id: "agent-b" },
      arenaPositions: {
        agent1: [348, 0.42, 402] as [number, number, number],
        agent2: [352, 0.42, 402] as [number, number, number],
      },
    },
    cameraTarget: "agent-a",
  };
}

function readyEquipmentVisuals() {
  return {
    getStreamingDuelEquipmentVisualReadiness: () => ({
      configured: true,
      ready: true,
      cycleId: "cycle-1",
      requiredCount: 1,
      readyCount: 1,
      unresolved: [],
      attachmentMismatches: [],
    }),
  };
}

describe("streaming scene diagnostics", () => {
  it("collects allowlisted avatar, simulation, projection, and camera evidence", () => {
    const agentA = {
      id: "internal-a",
      data: { characterId: "agent-a" },
      node: {
        position: vector(348, 0.42, 402, [-0.25, 0.1, 0.5], (value) =>
          value.y > 1 ? [-0.24, 0.48, 0.49] : [-0.25, 0.1, 0.5],
        ),
      },
      base: {
        position: vector(348.02, 0.42, 402.01),
        quaternion: yaw(-Math.PI / 2),
      },
      avatar: {
        getBoneTransform: () => matrixAt(348, 2.05, 402),
        instance: { raw: { scene: { visible: true } } },
      },
      lerpPosition: { current: vector(347, 0.42, 402) },
      active: true,
      destroyed: false,
    };
    const agentB = {
      id: "agent-b",
      data: { id: "agent-b" },
      node: {
        position: vector(352, 0.42, 402, [0.25, 0.1, 0.5], (value) =>
          value.y > 1 ? [0.24, 0.48, 0.49] : [0.25, 0.1, 0.5],
        ),
      },
      base: {
        position: vector(352, 0.42, 402),
        quaternion: yaw(Math.PI / 2),
      },
      avatar: {
        getBoneTransform: () => matrixAt(352, 2.05, 402),
        instance: { raw: { scene: { visible: true } } },
      },
      active: true,
      destroyed: false,
    };
    const tilePositions = new Map([
      ["agent-a", vector(348.1, 0.42, 402)],
      ["agent-b", vector(351.9, 0.42, 402)],
    ]);
    const lineOfSightTargets: Array<{ x: number; y: number; z: number }> = [];
    const world: StreamingDiagnosticsWorld = {
      camera: {
        position: vector(350, 8, 394),
        fov: 50,
        aspect: 16 / 9,
      },
      entities: {
        get: (id) => (id === "agent-b" ? agentB : null),
        players: new Map([["opaque-map-key", agentA]]),
      },
      getSystem: (name) => {
        if (name === "network") {
          return {
            tileInterpolator: {
              getVisualPosition: (id: string) => tilePositions.get(id) ?? null,
            },
          };
        }
        if (name === "client-camera-system") {
          return {
            getCameraInfo: () => ({
              target: agentA,
              position: [350, 8, 394],
            }),
            getStreamingCinematicLineOfSight: (target: {
              x: number;
              y: number;
              z: number;
            }) => {
              lineOfSightTargets.push(target);
              return true;
            },
            getStreamingCinematicEnvironmentLineOfSight: (target: {
              x: number;
              y: number;
              z: number;
            }) => {
              lineOfSightTargets.push(target);
              return true;
            },
          };
        }
        if (name === "duel-arena-visuals") {
          return { isReady: () => true };
        }
        if (name === "equipment-visual") return readyEquipmentVisuals();
        return null;
      },
    };

    expect(collectStreamingSceneDiagnostics(world, state(), 10_000)).toEqual({
      schemaVersion: 1,
      updatedAt: 10_000,
      cycleId: "cycle-1",
      phase: "FIGHTING",
      agents: [
        {
          id: "agent-a",
          arenaSpawnPosition: [348, 0.42, 402],
          simulationPosition: [348.1, 0.42, 402],
          renderPosition: [348, 0.42, 402],
          avatarPosition: [348.02, 0.42, 402.01],
          renderQuaternion: [0, -0.7071067811865475, 0, 0.7071067811865476],
          facingTargetErrorDegrees: 0,
          avatarReady: true,
          ndcPosition: [-0.25, 0.1, 0.5],
          ndcHeadPosition: [-0.24, 0.48, 0.49],
          insideCombatArena: true,
          insideAssignedCombatArena: true,
          cameraLineOfSight: { head: true, torso: true, lowerBody: true },
          visible: true,
          active: true,
        },
        {
          id: "agent-b",
          arenaSpawnPosition: [352, 0.42, 402],
          simulationPosition: [351.9, 0.42, 402],
          renderPosition: [352, 0.42, 402],
          avatarPosition: [352, 0.42, 402],
          renderQuaternion: [0, 0.7071067811865475, 0, 0.7071067811865476],
          facingTargetErrorDegrees: 0,
          avatarReady: true,
          ndcPosition: [0.25, 0.1, 0.5],
          ndcHeadPosition: [0.24, 0.48, 0.49],
          insideCombatArena: true,
          insideAssignedCombatArena: true,
          cameraLineOfSight: { head: true, torso: true, lowerBody: true },
          visible: true,
          active: true,
        },
      ],
      arenaSpawnSeparationXZ: 4,
      renderedSeparationXZ: 4,
      arenaVisualsReady: true,
      camera: {
        position: [350, 8, 394],
        fov: 50,
        aspect: 16 / 9,
        radius: null,
        preparationShotActive: false,
        preparationPairShotActive: false,
        targetId: "agent-a",
        expectedTargetId: "agent-a",
      },
    });
    expect(lineOfSightTargets).toEqual([
      { x: 348, y: 2.05, z: 402 },
      { x: 348, y: 1.3654, z: 402 },
      { x: 348, y: 0.746, z: 402 },
      { x: 352, y: 2.05, z: 402 },
      { x: 352, y: 1.3654, z: 402 },
      { x: 352, y: 0.746, z: 402 },
    ]);
    expect(areStreamingSceneAssetsReady(world, state())).toBe(true);
  });

  it("includes bounded bow and projectile presentation evidence from the live systems", () => {
    const agent = (id: string, x: number) => ({
      id,
      node: { position: vector(x, 0.42, 402) },
      base: { position: vector(x, 0.42, 402) },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    });
    const entities = new Map([
      ["agent-a", agent("agent-a", 348)],
      ["agent-b", agent("agent-b", 352)],
    ]);
    const bow = {
      schemaVersion: 1 as const,
      updatedAt: 10,
      latestSequence: 2,
      players: [],
      recentTransitions: [],
    };
    const projectiles = {
      schemaVersion: 1 as const,
      updatedAt: 10,
      latestSequence: 3,
      latestImpactSequence: 2,
      arrowLaunchEventCount: 3,
      arrowSpawnCount: 3,
      arrowCancelledBeforeSpawnCount: 0,
      arrowImpactEventCount: 2,
      arrowExpiredBeforeImpactCount: 0,
      pendingArrowCount: 0,
      activeArrows: [],
      recentArrowSpawns: [],
      recentArrowImpacts: [],
    };
    const damage = {
      schemaVersion: 1 as const,
      updatedAt: 10,
      latestSequence: 2,
      activeSplatCount: 1,
      recentEvents: [],
    };
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => entities.get(id) },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") {
          return {
            getStreamingDuelBowPresentationDiagnostics: (
              playerIds: readonly string[],
            ) => ({
              ...bow,
              players: playerIds.map((playerId) => ({ playerId })),
            }),
          };
        }
        if (name === "projectile-renderer") {
          return { getStreamingProjectileVisualDiagnostics: () => projectiles };
        }
        if (name === "damage-splat") {
          return { getStreamingDamagePresentationDiagnostics: () => damage };
        }
        return null;
      },
    };

    const diagnostics = collectStreamingSceneDiagnostics(world, state(), 10);
    expect(diagnostics?.combatPresentation).toEqual({
      bow: {
        ...bow,
        players: [{ playerId: "agent-a" }, { playerId: "agent-b" }],
      },
      projectiles,
      damage,
    });
    expect(
      collectStreamingSceneReadinessEvidence(world, state()),
    ).toMatchObject({
      damagePresentationAvailable: true,
      activeDamageSplatCount: 1,
    });
  });

  it("uses the production world network instead of stale entity interpolation", () => {
    const agentA = {
      id: "agent-a",
      position: vector(348, 0.42, 402),
      node: { position: vector(348, 0.42, 402) },
      base: { position: vector(348, 0.42, 402) },
      lerpPosition: { current: vector(300, 0.42, 300) },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    };
    const agentB = {
      id: "agent-b",
      position: vector(352, 0.42, 402),
      node: { position: vector(352, 0.42, 402) },
      base: { position: vector(352, 0.42, 402) },
      lerpPosition: { current: vector(301, 0.42, 300) },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    };
    const entities = new Map<string, unknown>([
      ["agent-a", agentA],
      ["agent-b", agentB],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => entities.get(id) },
      network: {
        tileInterpolator: {
          getVisualPosition: (id: string) =>
            id === "agent-a"
              ? vector(348.1, 0.42, 402)
              : vector(351.9, 0.42, 402),
        },
      },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") return readyEquipmentVisuals();
        return null;
      },
    };

    const diagnostics = collectStreamingSceneDiagnostics(world, state());
    expect(
      diagnostics?.agents.map((agent) => agent?.simulationPosition),
    ).toEqual([
      [348.1, 0.42, 402],
      [351.9, 0.42, 402],
    ]);
  });

  it("exposes only valid bounded avatar hit-reaction telemetry", () => {
    const avatar = (triggerCount: number, invalid = false) => ({
      emote: "asset://emotes/emote_sword_swing.glb?s=1.2",
      instance: {
        raw: { scene: { visible: true } },
        getHitReactionDiagnostics: () =>
          invalid
            ? { schemaVersion: 1, triggerCount: -1 }
            : {
                schemaVersion: 1,
                availableBoneCount: 5,
                triggerCount,
                active: true,
                elapsedSeconds: 0.08,
                currentWeight: 0.72,
                lastIntensity: 0.91,
                lastSide: -1,
              },
        getAuthoredMotionDiagnostics: () =>
          invalid
            ? {
                schemaVersion: 1,
                overflow: false,
                invalidActionCount: 0,
                actions: [
                  {
                    url: "asset://emotes/attack.glb?private=value",
                    running: true,
                    paused: false,
                    effectiveWeight: 0.8,
                  },
                ],
              }
            : {
                schemaVersion: 1,
                overflow: false,
                invalidActionCount: 0,
                actions: [
                  {
                    url: "asset://emotes/emote_sword_swing.glb",
                    running: true,
                    paused: false,
                    effectiveWeight: 0.8,
                  },
                ],
              },
      },
    });
    const entities = new Map([
      [
        "agent-a",
        {
          id: "agent-a",
          node: { position: vector(348, 0.42, 402) },
          base: { position: vector(348, 0.42, 402) },
          avatar: avatar(3),
          active: true,
        },
      ],
      [
        "agent-b",
        {
          id: "agent-b",
          node: { position: vector(352, 0.42, 402) },
          base: { position: vector(352, 0.42, 402) },
          avatar: avatar(0, true),
          active: true,
        },
      ],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => entities.get(id) },
      getSystem: (name) =>
        name === "duel-arena-visuals" ? { isReady: () => true } : null,
    };

    const diagnostics = collectStreamingSceneDiagnostics(world, state(), 30);
    expect(diagnostics?.agents[0]?.hitReaction).toEqual({
      schemaVersion: 1,
      availableBoneCount: 5,
      triggerCount: 3,
      active: true,
      elapsedSeconds: 0.08,
      currentWeight: 0.72,
      lastIntensity: 0.91,
      lastSide: -1,
      requiredBoneCount: 5,
    });
    expect(diagnostics?.agents[0]?.avatarEmote).toBe(
      "asset://emotes/emote_sword_swing.glb",
    );
    expect(diagnostics?.agents[0]?.authoredMotion).toEqual({
      schemaVersion: 1,
      overflow: false,
      invalidActionCount: 0,
      actions: [
        {
          url: "asset://emotes/emote_sword_swing.glb",
          running: true,
          paused: false,
          effectiveWeight: 0.8,
        },
      ],
    });
    expect(diagnostics?.agents[1]).not.toHaveProperty("hitReaction");
    expect(diagnostics?.agents[1]).not.toHaveProperty("authoredMotion");
  });

  it("reports missing scene entities without throwing", () => {
    const world: StreamingDiagnosticsWorld = {
      camera: {
        position: vector(350, 8, 394),
        fov: 50,
        aspect: 16 / 9,
      },
      entities: { get: () => null },
      getSystem: () => ({
        getCameraInfo: () => ({ position: [350, 8, 394] }),
      }),
    };

    const diagnostics = collectStreamingSceneDiagnostics(world, state(), 20);
    expect(diagnostics?.agents).toEqual([
      {
        id: "agent-a",
        arenaSpawnPosition: [348, 0.42, 402],
        simulationPosition: null,
        renderPosition: null,
        avatarPosition: null,
        renderQuaternion: null,
        facingTargetErrorDegrees: null,
        avatarReady: false,
        ndcPosition: null,
        ndcHeadPosition: null,
        insideCombatArena: false,
        insideAssignedCombatArena: null,
        cameraLineOfSight: null,
        visible: false,
        active: false,
      },
      {
        id: "agent-b",
        arenaSpawnPosition: [352, 0.42, 402],
        simulationPosition: null,
        renderPosition: null,
        avatarPosition: null,
        renderQuaternion: null,
        facingTargetErrorDegrees: null,
        avatarReady: false,
        ndcPosition: null,
        ndcHeadPosition: null,
        insideCombatArena: false,
        insideAssignedCombatArena: null,
        cameraLineOfSight: null,
        visible: false,
        active: false,
      },
    ]);
    expect(diagnostics?.renderedSeparationXZ).toBeNull();
    expect(diagnostics?.arenaVisualsReady).toBe(false);
    expect(areStreamingSceneAssetsReady(world, state())).toBe(false);
  });

  it("waits for critical world visuals and queued GPU precompiles", () => {
    const agent = (id: string, x: number) => ({
      id,
      node: { position: vector(x, 0.42, 402) },
      base: { position: vector(x, 0.42, 402) },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    });
    let worldVisualsReady = false;
    let precompileIdle = false;
    const entities = new Map([
      ["agent-a", agent("agent-a", 348)],
      ["agent-b", agent("agent-b", 352)],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => entities.get(id) },
      graphics: { isPrecompileIdle: () => precompileIdle },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") return readyEquipmentVisuals();
        if (name === "terrain") {
          return {
            getStreamingVisualReadiness: () => ({ ready: worldVisualsReady }),
          };
        }
        return null;
      },
    };

    expect(areStreamingSceneAssetsReady(world, state())).toBe(false);
    worldVisualsReady = true;
    expect(areStreamingSceneAssetsReady(world, state())).toBe(false);
    precompileIdle = true;
    expect(areStreamingSceneAssetsReady(world, state())).toBe(true);
  });

  it("fails closed while an exact frozen equipment visual is unresolved", () => {
    const agent = (id: string, x: number) => ({
      id,
      node: { position: vector(x, 0.42, 402) },
      base: { position: vector(x, 0.42, 402) },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    });
    const entities = new Map([
      ["agent-a", agent("agent-a", 348)],
      ["agent-b", agent("agent-b", 352)],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => entities.get(id) },
      graphics: { isPrecompileIdle: () => true },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") {
          return {
            getStreamingDuelEquipmentVisualReadiness: () => ({
              configured: true,
              ready: false,
              cycleId: "cycle-1",
              requiredCount: 2,
              readyCount: 1,
              unresolved: [
                {
                  itemId: "bronze_platebody",
                  slot: "body",
                  status: "missing_model",
                },
              ],
              attachmentMismatches: [],
            }),
          };
        }
        return null;
      },
    };

    expect(areStreamingSceneAssetsReady(world, state())).toBe(false);
  });

  it("requires two production avatars while maintenance keeps the cycle idle", () => {
    const readyAgent = (id: string, useFallback = false) => ({
      id,
      data: { characterId: id, isAgent: true },
      node: { position: vector(348, 0.42, 402), visible: true },
      base: { position: vector(348, 0.42, 402), visible: true },
      ...(useFallback
        ? { _fallbackAvatarRoot: { visible: true } }
        : { avatar: { instance: { raw: { scene: { visible: true } } } } }),
      active: true,
    });
    const agents = new Map<string, unknown>([
      ["agent-a", readyAgent("agent-a")],
      ["agent-b", readyAgent("agent-b", true)],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: () => null, players: agents },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") return readyEquipmentVisuals();
        return null;
      },
    };
    const idleState = {
      cycle: {
        cycleId: "",
        phase: "IDLE",
        agent1: null,
        agent2: null,
        arenaPositions: null,
      },
      cameraTarget: null,
    };

    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(false);
    agents.set("agent-b", readyAgent("agent-b"));
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(true);
  });

  it("accepts loaded, GPU-precompiled contestants off-camera while idle", () => {
    const hiddenAgent = (id: string) => ({
      id,
      data: { characterId: id, isAgent: true },
      node: { position: vector(0, 31, 0), visible: true },
      base: { position: vector(0, 31, 0), visible: true },
      avatar: { instance: { raw: { scene: { visible: false } } } },
      active: true,
    });
    const agents = new Map<string, unknown>([
      ["agent-a", hiddenAgent("agent-a")],
      ["agent-b", hiddenAgent("agent-b")],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: {
        get: (id) => agents.get(id),
        players: agents,
      },
      graphics: { isPrecompileIdle: () => true },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") return readyEquipmentVisuals();
        return null;
      },
    };
    const idleState = {
      ...state(),
      cycle: { ...state().cycle, phase: "IDLE" },
    };

    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(true);
  });

  it("requires visible contestants and attached preparation tools while idle preparation is active", () => {
    const preparingAgent = (id: string, x: number) => ({
      id,
      data: {
        characterId: id,
        isAgent: true,
        gatheringToolPresentation: { revision: 1, itemId: "harpoon" },
        fishingInteractionPresentation: {
          revision: 1,
          itemId: "harpoon",
          phase: "held",
        },
      },
      node: { position: vector(x, 28.08, -12.5), visible: true },
      base: { position: vector(x, 28.08, -12.5), visible: true },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    });
    const agents = new Map<string, unknown>([
      ["agent-a", preparingAgent("agent-a", -8.75)],
      ["agent-b", preparingAgent("agent-b", -1.75)],
    ]);
    let preparationVisualsReady = false;
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(-5.25, 35, -22), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => agents.get(id), players: agents },
      graphics: { isPrecompileIdle: () => true },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") {
          return {
            ...readyEquipmentVisuals(),
            getStreamingPreparationVisualDiagnostics: () => ({
              schemaVersion: 1,
              updatedAt: 1,
              activeCount: 2,
              readyCount: preparationVisualsReady ? 2 : 1,
              ready: preparationVisualsReady,
              players: [],
            }),
          };
        }
        return null;
      },
    };
    const idleState = {
      ...state(),
      cycle: { ...state().cycle, phase: "IDLE" },
    };

    const diagnostics = collectStreamingSceneDiagnostics(world, idleState);
    expect(
      diagnostics?.agents.map(
        (agent) => agent?.preparationPresentation?.gatheringToolItemId,
      ),
    ).toEqual(["harpoon", "harpoon"]);
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(false);

    preparationVisualsReady = true;
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(true);

    const hidden = agents.get("agent-b") as {
      avatar: { instance: { raw: { scene: { visible: boolean } } } };
    };
    hidden.avatar.instance.raw.scene.visible = false;
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(false);
  });

  it("treats authoritative processing work as active fail-closed preparation", () => {
    const processingAgent = (id: string, x: number) => ({
      id,
      data: {
        characterId: id,
        isAgent: true,
        processingInteractionPresentation: {
          revision: 4,
          skill: "smithing",
          phase: "working",
          phaseStartedAtServerTimeMs: 2000,
          targetPosition: { x: x + 1, y: 28, z: -10 },
        },
      },
      node: { position: vector(x, 28, -11), visible: true },
      base: { position: vector(x, 28, -11), visible: true },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    });
    const agents = new Map<string, unknown>([
      ["agent-a", processingAgent("agent-a", -4)],
      ["agent-b", processingAgent("agent-b", 2)],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(-1, 35, -20), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => agents.get(id), players: agents },
      graphics: { isPrecompileIdle: () => true },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") {
          return {
            ...readyEquipmentVisuals(),
            getStreamingPreparationVisualDiagnostics: () => ({
              schemaVersion: 1,
              updatedAt: 1,
              activeCount: 2,
              readyCount: 0,
              ready: false,
              players: [],
            }),
          };
        }
        return null;
      },
    };
    const idleState = {
      ...state(),
      cycle: { ...state().cycle, phase: "IDLE" },
    };

    const diagnostics = collectStreamingSceneDiagnostics(world, idleState);
    expect(
      diagnostics?.agents.map(
        (agent) => agent?.preparationPresentation?.processingSkill,
      ),
    ).toEqual(["smithing", "smithing"]);
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(false);
  });

  it("accepts a settled ready preparation with no transient work visual while active unresolved work still fails closed", () => {
    const readyAgent = (id: string, x: number) => ({
      id,
      data: { characterId: id, isAgent: true },
      node: { position: vector(x, 28, -11), visible: true },
      base: { position: vector(x, 28, -11), visible: true },
      avatar: { instance: { raw: { scene: { visible: true } } } },
      active: true,
    });
    const agents = new Map<string, unknown>([
      ["agent-a", readyAgent("agent-a", -4)],
      ["agent-b", readyAgent("agent-b", 2)],
    ]);
    let preparationVisuals = {
      schemaVersion: 1 as const,
      updatedAt: 1,
      activeCount: 0,
      readyCount: 0,
      ready: false,
      players: [],
    };
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(-1, 35, -20), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => agents.get(id), players: agents },
      graphics: { isPrecompileIdle: () => true },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") {
          return {
            ...readyEquipmentVisuals(),
            getStreamingPreparationVisualDiagnostics: () => preparationVisuals,
          };
        }
        return null;
      },
    };
    const idleState = {
      ...state(),
      cycle: { ...state().cycle, phase: "IDLE" },
      preparation: {
        status: "ready",
        agent1: { id: "agent-a" },
        agent2: { id: "agent-b" },
      },
    };

    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(true);

    idleState.preparation.status = "preparing";
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(false);

    idleState.preparation.status = "ready";
    preparationVisuals = {
      ...preparationVisuals,
      activeCount: 1,
      readyCount: 0,
      ready: false,
    };
    expect(areStreamingSceneAssetsReady(world, idleState)).toBe(false);
  });

  it("requires loaded contestants to be visible once an arena phase begins", () => {
    const hiddenAgent = (id: string) => ({
      id,
      data: { characterId: id, isAgent: true },
      node: { position: vector(348, 0.42, 402), visible: true },
      base: { position: vector(348, 0.42, 402), visible: true },
      avatar: { instance: { raw: { scene: { visible: false } } } },
      active: true,
    });
    const agents = new Map<string, unknown>([
      ["agent-a", hiddenAgent("agent-a")],
      ["agent-b", hiddenAgent("agent-b")],
    ]);
    const world: StreamingDiagnosticsWorld = {
      camera: { position: vector(350, 8, 394), fov: 50, aspect: 16 / 9 },
      entities: { get: (id) => agents.get(id), players: agents },
      graphics: { isPrecompileIdle: () => true },
      getSystem: (name) => {
        if (name === "duel-arena-visuals") return { isReady: () => true };
        if (name === "equipment-visual") return readyEquipmentVisuals();
        return null;
      },
    };

    expect(areStreamingSceneAssetsReady(world, state())).toBe(false);
  });

  it("requires a sustained ready window and resets immediately on regression", () => {
    let stability = {
      readySince: null as number | null,
      consecutiveSamples: 0,
      ready: false,
    };
    for (const now of [0, 250, 500, 750]) {
      stability = advanceStreamingReadinessStability(
        stability,
        true,
        now,
        1_000,
        5,
      );
      expect(stability.ready).toBe(false);
    }
    stability = advanceStreamingReadinessStability(
      stability,
      true,
      1_000,
      1_000,
      5,
    );
    expect(stability.ready).toBe(true);
    expect(advanceStreamingReadinessStability(stability, false, 1_001)).toEqual(
      {
        readySince: null,
        consecutiveSamples: 0,
        ready: false,
      },
    );
  });

  it("holds cold renderer readiness through resource churn and retained long frames", () => {
    const snapshot = (
      updatedAt: number,
      uptimeMs: number,
      textures: number,
      geometries: number,
      longFrameSequence = 0,
      longFrameUptimeMs = 0,
    ) =>
      ({
        schemaVersion: 1,
        updatedAt,
        uptimeMs,
        overall: {
          frames: Math.floor(uptimeMs / 16),
          renderer: {
            textures: { latest: textures },
            geometries: { latest: geometries },
          },
        },
        longFrames:
          longFrameSequence === 0
            ? []
            : [
                {
                  frameSequence: longFrameSequence,
                  uptimeMs: longFrameUptimeMs,
                  frameWorkMs: 300,
                },
              ],
      }) as never;

    let stability = createStreamingColdRenderStability();
    const noMinimumObservation = { minimumObservationMs: 0 };
    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(1_000, 1_000, 20, 30),
      noMinimumObservation,
    );
    expect(stability.ready).toBe(false);

    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(2_000, 2_000, 21, 31),
      noMinimumObservation,
    );
    expect(stability.consecutiveSnapshots).toBe(1);

    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(3_000, 3_000, 21, 31, 42, 2_900),
      noMinimumObservation,
    );
    expect(stability.consecutiveSnapshots).toBe(1);
    expect(stability.ready).toBe(false);

    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(4_000, 4_000, 21, 31, 42, 2_900),
      noMinimumObservation,
    );
    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(5_000, 5_000, 21, 31, 42, 2_900),
      noMinimumObservation,
    );
    expect(stability.ready).toBe(true);
  });

  it("does not treat a scheduler-only interval miss as cold GPU work", () => {
    const snapshot = (updatedAt: number, uptimeMs: number, sequence: number) =>
      ({
        schemaVersion: 1,
        updatedAt,
        uptimeMs,
        overall: {
          frames: sequence,
          renderer: {
            textures: { latest: 20 },
            geometries: { latest: 30 },
          },
        },
        longFrames: [
          {
            frameSequence: sequence,
            uptimeMs,
            frameIntervalMs: 66,
            frameWorkMs: 20,
          },
        ],
      }) as never;
    const options = {
      stableDurationMs: 2_000,
      minimumSnapshots: 3,
      minimumObservationMs: 0,
    };
    let stability = createStreamingColdRenderStability();
    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(1_000, 1_000, 60),
      options,
    );
    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(2_000, 2_000, 90),
      options,
    );
    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(3_000, 3_000, 120),
      options,
    );

    expect(stability).toMatchObject({
      lastLongFrameSequence: 0,
      consecutiveSnapshots: 3,
      ready: true,
    });
  });

  it("ignores duplicate performance publications and latches a settled renderer", () => {
    const snapshot = {
      schemaVersion: 1,
      updatedAt: 1_000,
      uptimeMs: 1_000,
      overall: {
        frames: 60,
        renderer: {
          textures: { latest: 20 },
          geometries: { latest: 30 },
        },
      },
      longFrames: [],
    } as never;
    const first = advanceStreamingColdRenderStability(
      createStreamingColdRenderStability(),
      snapshot,
      {
        stableDurationMs: 0,
        minimumSnapshots: 1,
        minimumObservationMs: 0,
      },
    );
    expect(first.ready).toBe(true);
    expect(advanceStreamingColdRenderStability(first, snapshot)).toBe(first);
  });

  it("starts the cold renderer quiet window only after scene assets are ready", () => {
    const snapshot = {
      schemaVersion: 1,
      updatedAt: 5_000,
      uptimeMs: 5_000,
      overall: {
        frames: 300,
        renderer: {
          textures: { latest: 20 },
          geometries: { latest: 30 },
        },
      },
      resources: { entries: 40 },
      longFrames: [],
    } as never;
    const initial = createStreamingColdRenderStability();
    const whileLoading = advanceStreamingColdRenderStability(
      initial,
      snapshot,
      {
        sceneAssetsReady: false,
        stableDurationMs: 0,
        minimumSnapshots: 1,
        minimumObservationMs: 0,
      },
    );
    expect(whileLoading).toEqual(initial);

    const afterAssetsReady = advanceStreamingColdRenderStability(
      whileLoading,
      snapshot,
      {
        sceneAssetsReady: true,
        stableDurationMs: 0,
        minimumSnapshots: 1,
        minimumObservationMs: 0,
      },
    );
    expect(afterAssetsReady).toMatchObject({
      lastSnapshotUpdatedAt: 5_000,
      lastAssetResourceEntryCount: 0,
      observationStartedAtUptimeMs: 5_000,
      quietSinceUptimeMs: 5_000,
      ready: true,
    });
  });

  it("requires a bounded observation period after assets become ready", () => {
    const snapshot = (updatedAt: number, uptimeMs: number) =>
      ({
        schemaVersion: 1,
        updatedAt,
        uptimeMs,
        overall: {
          frames: Math.floor(uptimeMs / 16),
          renderer: {
            textures: { latest: 20 },
            geometries: { latest: 30 },
          },
        },
        resources: null,
        longFrames: [],
      }) as never;
    const options = {
      stableDurationMs: 0,
      minimumSnapshots: 2,
      minimumObservationMs: 10_000,
    };
    let stability = advanceStreamingColdRenderStability(
      createStreamingColdRenderStability(),
      snapshot(1_000, 1_000),
      options,
    );
    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(10_999, 10_999),
      options,
    );
    expect(stability.ready).toBe(false);

    stability = advanceStreamingColdRenderStability(
      stability,
      snapshot(11_000, 11_000),
      options,
    );
    expect(stability.ready).toBe(true);
  });
});
