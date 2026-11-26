import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  attachStreamingViewerToken,
  advanceDuelTerminalHandoff,
  captureScenarioIdentity,
  classifyDuelCaptureScenarios,
  createDuelTerminalHandoff,
  duelCaptureStatesAgree,
  evaluateDuelPresentationCapture,
  evaluateDuelSafeCrop,
  evaluateDuelSceneCapture,
  normalizeDuelCaptureState,
  normalizeDuelPresentationDiagnostics,
  normalizeDuelSceneDiagnostics,
  parseDuelSafeCrop,
  REQUIRED_DUEL_CAPTURE_SCENARIOS,
} from "../../../../../scripts/duel-capture-scenarios.mjs";

const captureRunnerSource = readFileSync(
  new URL(
    "../../../../../scripts/capture-duel-arena-scenarios.mjs",
    import.meta.url,
  ),
  "utf8",
);

const agent = (id: string, hp = 50, damageDealtThisFight = 0) => ({
  id,
  name: `${id}-name`,
  hp,
  maxHp: 50,
  damageDealtThisFight,
  equipment: { weapon: "private-loadout-detail" },
});

function state(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "STREAMING_STATE_UPDATE",
    cycle: {
      cycleId: "cycle-1",
      phase: "FIGHTING",
      phaseVersion: 3,
      agent1: agent("agent-a"),
      agent2: agent("agent-b"),
      arenaPositions: {
        agent1: [348, 0.42, 402],
        agent2: [352, 0.42, 402],
      },
      outcome: null,
      winnerId: null,
      ...(overrides.cycle as Record<string, unknown> | undefined),
    },
    cameraTarget:
      "cameraTarget" in overrides ? overrides.cameraTarget : "agent-a",
    terminalNotice: overrides.terminalNotice ?? null,
    injectedSecret: "must-not-survive",
  };
}

function scene(overrides: Record<string, unknown> = {}) {
  const agents = [
    {
      id: "agent-a",
      arenaSpawnPosition: [348, 0.42, 402],
      simulationPosition: [348.1, 0.42, 402],
      renderPosition: [348, 0.42, 402],
      avatarPosition: [348.02, 0.42, 402],
      renderQuaternion: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
      facingTargetErrorDegrees: 0,
      avatarReady: true,
      ndcPosition: [-0.25, 0.1, 0.5],
      ndcHeadPosition: [-0.25, 0.48, 0.49],
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
      renderQuaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      facingTargetErrorDegrees: 0,
      avatarReady: true,
      ndcPosition: [0.25, 0.1, 0.5],
      ndcHeadPosition: [0.25, 0.48, 0.49],
      insideCombatArena: true,
      insideAssignedCombatArena: true,
      cameraLineOfSight: { head: true, torso: true, lowerBody: true },
      visible: true,
      active: true,
    },
  ];
  return {
    schemaVersion: 1,
    updatedAt: 10_000,
    cycleId: "cycle-1",
    phase: "FIGHTING",
    agents,
    arenaSpawnSeparationXZ: 4,
    renderedSeparationXZ: 4,
    arenaVisualsReady: true,
    camera: {
      position: [350, 8, 394],
      fov: 50,
      aspect: 16 / 9,
      targetId: "agent-a",
      expectedTargetId: "agent-a",
    },
    ...overrides,
  };
}

function presentation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    rootCount: 1,
    bodyTextLength: 500,
    errorOverlayCount: 0,
    victoryOverlayCount: 0,
    postFightCardCount: 0,
    countdownOverlayCount: 0,
    combatLogCount: 1,
    leaderboardCount: 0,
    betweenStripCount: 0,
    activeHudCount: 1,
    agentStatsCount: 2,
    cancellationStatusCount: 0,
    healPopupCount: 0,
    ...overrides,
  };
}

describe("duel arena capture scenarios", () => {
  it("preserves assigned-arena and camera line-of-sight evidence", () => {
    const normalized = normalizeDuelSceneDiagnostics(scene());

    expect(normalized?.agents[0]).toMatchObject({
      insideAssignedCombatArena: true,
      cameraLineOfSight: { head: true, torso: true, lowerBody: true },
    });
    expect(normalized?.agents[1]).toMatchObject({
      insideAssignedCombatArena: true,
      cameraLineOfSight: { head: true, torso: true, lowerBody: true },
    });
  });

  it("rejects missing or malformed spatial-observability evidence", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    const { insideAssignedCombatArena: _missing, ...missingAssigned } =
      agents[0];

    expect(
      normalizeDuelSceneDiagnostics({
        ...scene(),
        agents: [missingAssigned, agents[1]],
      }),
    ).toBeNull();
    expect(
      normalizeDuelSceneDiagnostics({
        ...scene(),
        agents: [
          {
            ...agents[0],
            cameraLineOfSight: {
              head: true,
              torso: "yes",
              lowerBody: true,
            },
          },
          agents[1],
        ],
      }),
    ).toBeNull();
  });

  it("preserves an avatar's exact authored hit-reaction bone requirement", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    const normalized = normalizeDuelSceneDiagnostics({
      ...scene(),
      agents: [
        {
          ...agents[0],
          hitReaction: {
            schemaVersion: 1,
            requiredBoneCount: 3,
            availableBoneCount: 3,
            triggerCount: 2,
            active: true,
            elapsedSeconds: 0.1,
            currentWeight: 0.7,
            lastIntensity: 0.8,
            lastSide: -1,
          },
        },
        agents[1],
      ],
    });

    expect(normalized?.agents[0]?.hitReaction).toMatchObject({
      requiredBoneCount: 3,
      availableBoneCount: 3,
    });
  });

  it("rejects impossible authored hit-reaction bone requirements", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    expect(
      normalizeDuelSceneDiagnostics({
        ...scene(),
        agents: [
          {
            ...agents[0],
            hitReaction: {
              schemaVersion: 1,
              requiredBoneCount: 6,
              availableBoneCount: 3,
              triggerCount: 0,
              active: false,
              elapsedSeconds: null,
              currentWeight: 0,
              lastIntensity: 0,
              lastSide: 1,
            },
          },
          agents[1],
        ],
      }),
    ).toBeNull();
  });

  it("preserves bounded authored mixer evidence and rejects query-bearing action URLs", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    const authoredMotion = {
      schemaVersion: 1,
      overflow: false,
      invalidActionCount: 0,
      actions: [
        {
          url: "asset://emotes/emote_sword_swing.glb",
          running: true,
          paused: false,
          effectiveWeight: 0.65,
        },
      ],
    };
    const normalized = normalizeDuelSceneDiagnostics({
      ...scene(),
      agents: [{ ...agents[0], authoredMotion }, agents[1]],
    });
    expect(normalized?.agents[0]?.authoredMotion).toEqual(authoredMotion);

    expect(
      normalizeDuelSceneDiagnostics({
        ...scene(),
        agents: [
          {
            ...agents[0],
            authoredMotion: {
              ...authoredMotion,
              actions: [
                {
                  ...authoredMotion.actions[0],
                  url: "asset://emotes/emote_sword_swing.glb?token=private",
                },
              ],
            },
          },
          agents[1],
        ],
      }),
    ).toBeNull();
  });

  it("gates screenshots on DOM presentation, HTTP responses, and terminal handoff", () => {
    expect(captureRunnerSource).toContain("evaluateDuelPresentationCapture(");
    expect(captureRunnerSource).toContain("evaluateDuelSafeCrop(");
    expect(captureRunnerSource).toContain('page.on("response"');
    expect(captureRunnerSource).toContain(
      "missingTerminalHandoffs.length === 0",
    );
    expect(captureRunnerSource).toContain("advanceDuelTerminalHandoff(");
  });

  it("pins outcome evidence to a fresh immutable 60 FPS browser run", () => {
    expect(captureRunnerSource).toContain("assertByteCompleteLaunchAssets();");
    expect(captureRunnerSource).toContain(
      "scripts/validate-duel-launch-assets.mjs",
    );
    expect(captureRunnerSource).toContain("process.execPath");
    expect(captureRunnerSource).toContain("applyCaptureFrameRateToUrl(");
    expect(captureRunnerSource).toContain('serviceWorkers: "block"');
    expect(captureRunnerSource).toContain('"Network.setCacheDisabled"');
    expect(captureRunnerSource).toContain('"Network.emulateNetworkConditions"');
    expect(captureRunnerSource).toContain('"Emulation.setCPUThrottlingRate"');
    expect(captureRunnerSource).toContain(
      "const stateBearerToken = distinctStateBearerToken || viewerToken",
    );
    expect(captureRunnerSource).toContain("await access(manifestPath)");
    expect(captureRunnerSource).toContain(
      "refusing to overwrite existing evidence",
    );
    expect(captureRunnerSource).toContain("browserConditionError === null");
  });

  it("adds a viewer token only to the URL fragment", () => {
    const tokenized = attachStreamingViewerToken(
      "https://stream.hyperia.example/stream.html?layout=broadcast#mode=live",
      "viewer-secret",
    );
    expect(tokenized.origin).toBe("https://stream.hyperia.example");
    expect(tokenized.pathname).toBe("/stream.html");
    expect(tokenized.searchParams.get("layout")).toBe("broadcast");
    expect(new URLSearchParams(tokenized.hash.slice(1)).get("mode")).toBe(
      "live",
    );
    expect(
      new URLSearchParams(tokenized.hash.slice(1)).get("streamToken"),
    ).toBe("viewer-secret");
    expect(attachStreamingViewerToken(tokenized, "").toString()).toBe(
      tokenized.toString(),
    );
  });

  it("classifies every required phase and terminal outcome deterministically", () => {
    const fixtures = [
      [state({ cycle: { phase: "IDLE", cycleId: "" } }), ["idle"]],
      [state({ cycle: { phase: "ANNOUNCEMENT" } }), ["announcement"]],
      [state({ cycle: { phase: "COUNTDOWN" } }), ["countdown"]],
      [state(), ["fighting"]],
      [
        state({
          cycle: {
            phase: "FIGHTING",
            agent1: agent("agent-a", 17, 33),
            agent2: agent("agent-b", 45, 5),
          },
        }),
        ["fighting", "fighting-low-health"],
      ],
      [
        state({
          cycle: {
            phase: "RESOLUTION",
            outcome: "win",
            winnerId: "agent-a",
          },
        }),
        ["resolution-win"],
      ],
      [
        state({
          cycle: {
            phase: "RESOLUTION",
            outcome: "draw",
            winnerId: null,
          },
        }),
        ["resolution-draw"],
      ],
      [
        state({
          cycle: { phase: "IDLE", cycleId: "" },
          terminalNotice: {
            cycleId: "cycle-cancelled",
            outcome: "cancelled",
            reason: "no_combat_activity",
            expiresAt: 20_000,
          },
        }),
        ["cancelled"],
      ],
    ] as const;

    const observedScenarios = new Set<string>();
    for (const [fixture, expected] of fixtures) {
      const actual = classifyDuelCaptureScenarios(fixture, 10_000);
      expect(actual).toEqual(expected);
      for (const scenario of actual) observedScenarios.add(scenario);
    }
    expect([...observedScenarios].sort()).toEqual(
      [...REQUIRED_DUEL_CAPTURE_SCENARIOS].sort(),
    );
  });

  it("requires exact browser/server capture identity agreement", () => {
    const canonical = state();
    expect(duelCaptureStatesAgree(canonical, structuredClone(canonical))).toBe(
      true,
    );
    expect(
      duelCaptureStatesAgree(canonical, state({ cycle: { phaseVersion: 4 } })),
    ).toBe(false);
    expect(
      duelCaptureStatesAgree(
        canonical,
        state({ cycle: { agent2: agent("substitute") } }),
      ),
    ).toBe(false);
    const cancellation = state({
      cycle: { phase: "IDLE", cycleId: "" },
      terminalNotice: {
        cycleId: "cycle-cancelled",
        outcome: "cancelled",
        reason: "no_combat_activity",
        expiresAt: 20_000,
      },
    });
    expect(
      duelCaptureStatesAgree(cancellation, {
        ...cancellation,
        terminalNotice: {
          ...(cancellation.terminalNotice as Record<string, unknown>),
          expiresAt: 20_001,
        },
      }),
    ).toBe(false);
  });

  it("allowlists capture evidence and rejects malformed public state", () => {
    const fixture = state({
      cycle: {
        phase: "RESOLUTION",
        outcome: "win",
        winnerId: "agent-a",
      },
    });
    const normalized = normalizeDuelCaptureState(fixture);
    expect(normalized).not.toHaveProperty("injectedSecret");
    expect(normalized?.agent1).toEqual({
      id: "agent-a",
      hp: 50,
      maxHp: 50,
      damageDealtThisFight: 0,
    });
    expect(normalized?.agent1).not.toHaveProperty("equipment");
    expect(captureScenarioIdentity(fixture, "resolution-win")).toEqual({
      scenario: "resolution-win",
      cycleId: "cycle-1",
      phase: "RESOLUTION",
      phaseVersion: 3,
      agent1Id: "agent-a",
      agent2Id: "agent-b",
      agent1Hp: 50,
      agent2Hp: 50,
      arenaPositions: {
        agent1: [348, 0.42, 402],
        agent2: [352, 0.42, 402],
      },
      cameraTarget: "agent-a",
      outcome: "win",
      winnerId: "agent-a",
      cancellationReason: null,
    });

    expect(normalizeDuelCaptureState({ cycle: {} })).toBeNull();
    expect(
      normalizeDuelCaptureState(
        state({ cycle: { winnerId: { injected: true } } }),
      ),
    ).toBeNull();
    expect(
      normalizeDuelCaptureState(
        state({ cycle: { agent1: agent("agent-a", 51) } }),
      ),
    ).toBeNull();
    expect(captureScenarioIdentity(fixture, "invented-scenario")).toBeNull();
  });

  it("does not treat an expired cancellation notice as visual coverage", () => {
    const fixture = state({
      cycle: { phase: "IDLE", cycleId: "" },
      terminalNotice: {
        cycleId: "cycle-cancelled",
        outcome: "cancelled",
        reason: "scheduler_shutdown",
        expiresAt: 9_999,
      },
    });
    expect(classifyDuelCaptureScenarios(fixture, 10_000)).toEqual(["idle"]);
  });

  it("does not credit a cancellation notice in a phase that cannot render it", () => {
    const fixture = state({
      cycle: { phase: "ANNOUNCEMENT", cycleId: "cycle-2" },
      terminalNotice: {
        cycleId: "cycle-cancelled",
        outcome: "cancelled",
        reason: "no_combat_activity",
        expiresAt: 20_000,
      },
    });
    expect(classifyDuelCaptureScenarios(fixture, 10_000)).toEqual([]);
  });

  it("rejects stale or missing phase-specific presentation layers", () => {
    expect(
      evaluateDuelPresentationCapture(presentation(), state(), 10_000),
    ).toMatchObject({ ok: true, issues: [] });

    const resolution = state({
      cycle: {
        phase: "RESOLUTION",
        outcome: "win",
        winnerId: "agent-a",
      },
    });
    expect(
      evaluateDuelPresentationCapture(presentation(), resolution, 10_000)
        .issues,
    ).toEqual(
      expect.arrayContaining([
        "victory_overlay_missing",
        "post_fight_card_missing",
        "active_hud_stale",
        "combat_log_stale",
      ]),
    );

    const idle = state({ cycle: { phase: "IDLE", cycleId: "" } });
    expect(
      evaluateDuelPresentationCapture(
        presentation({
          victoryOverlayCount: 1,
          postFightCardCount: 1,
          countdownOverlayCount: 1,
          healPopupCount: 1,
        }),
        idle,
        10_000,
      ).issues,
    ).toEqual(
      expect.arrayContaining([
        "victory_overlay_stale",
        "post_fight_card_stale",
        "countdown_overlay_stale",
        "heal_popup_outside_fight",
      ]),
    );
  });

  it("requires cancellation status and strictly allowlists DOM evidence", () => {
    const cancellation = state({
      cycle: { phase: "IDLE", cycleId: "", agent1: null, agent2: null },
      terminalNotice: {
        cycleId: "cycle-cancelled",
        outcome: "cancelled",
        reason: "no_combat_activity",
        expiresAt: 20_000,
      },
    });
    expect(
      evaluateDuelPresentationCapture(
        presentation({
          combatLogCount: 0,
          activeHudCount: 0,
          agentStatsCount: 0,
        }),
        cancellation,
        10_000,
      ).issues,
    ).toContain("cancellation_status_missing");
    expect(
      evaluateDuelPresentationCapture(
        presentation({
          combatLogCount: 0,
          activeHudCount: 0,
          agentStatsCount: 0,
          cancellationStatusCount: 1,
        }),
        cancellation,
        10_000,
      ).ok,
    ).toBe(true);
    expect(
      normalizeDuelPresentationDiagnostics({
        ...presentation(),
        victoryOverlayCount: -1,
      }),
    ).toBeNull();
    expect(
      normalizeDuelPresentationDiagnostics({
        ...presentation(),
        privateOverlayText: "must not enter evidence",
      }),
    ).not.toHaveProperty("privateOverlayText");
  });

  it("proves terminal presentation clears before the next cycle fights", () => {
    const terminal = state({
      cycle: {
        phase: "RESOLUTION",
        outcome: "win",
        winnerId: "agent-a",
      },
    });
    let handoff = advanceDuelTerminalHandoff(
      createDuelTerminalHandoff("resolution-win"),
      terminal,
      presentation({
        victoryOverlayCount: 1,
        postFightCardCount: 1,
        combatLogCount: 0,
        activeHudCount: 0,
        betweenStripCount: 1,
      }),
      10_000,
    );
    expect(handoff.terminalCycleId).toBe("cycle-1");

    const idle = state({ cycle: { phase: "IDLE", cycleId: "" } });
    handoff = advanceDuelTerminalHandoff(
      handoff,
      idle,
      presentation({
        combatLogCount: 0,
        activeHudCount: 0,
        betweenStripCount: 1,
      }),
      11_000,
    );
    expect(handoff.presentationClearedAt).toBe(11_000);

    handoff = advanceDuelTerminalHandoff(
      handoff,
      state({ cycle: { phase: "ANNOUNCEMENT", cycleId: "cycle-2" } }),
      presentation({
        combatLogCount: 0,
        activeHudCount: 0,
        betweenStripCount: 1,
      }),
      12_000,
    );
    expect(handoff.nextCycleId).toBe("cycle-2");
    expect(handoff.complete).toBe(false);

    handoff = advanceDuelTerminalHandoff(
      handoff,
      state({ cycle: { phase: "FIGHTING", cycleId: "cycle-2" } }),
      presentation(),
      13_000,
    );
    expect(handoff).toMatchObject({
      nextCycleId: "cycle-2",
      nextFightObservedAt: 13_000,
      complete: true,
    });
  });

  it("accepts fresh, in-ring, separated, in-frame scene evidence", () => {
    const evaluation = evaluateDuelSceneCapture(scene(), state(), 10_500);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.issues).toEqual([]);
    expect(evaluation.diagnostics).not.toHaveProperty("injectedSecret");
  });

  it("requires both declared crop axes and rejects a single unsafe projection", () => {
    expect(parseDuelSafeCrop(undefined, undefined)).toBeNull();
    expect(() => parseDuelSafeCrop("0.9", undefined)).toThrow(/requires both/);
    expect(() => parseDuelSafeCrop("0.9", "1.01")).toThrow(/at most 1/);

    const safeCrop = parseDuelSafeCrop("0.9", "0.82");
    const passing = evaluateDuelSafeCrop(scene(), safeCrop);
    expect(passing).toMatchObject({
      ok: true,
      issues: [],
      metrics: {
        expectedProjectionCount: 2,
        retainedProjectionCount: 2,
        violations: 0,
      },
    });

    const agents = scene().agents as Array<Record<string, unknown>>;
    const failing = evaluateDuelSafeCrop(
      scene({
        agents: [
          agents[0],
          {
            ...agents[1],
            ndcPosition: [0.91, -0.83, 0.5],
          },
        ],
      }),
      safeCrop,
    );
    expect(failing).toMatchObject({
      ok: false,
      issues: ["agent2_outside_safe_crop"],
      metrics: { violations: 1 },
    });
  });

  it("accepts loaded preview contestants parked off-arena while idle", () => {
    const hiddenPreviewAgents = ["agent-a", "agent-b"].map((id) => ({
      id,
      arenaSpawnPosition: null,
      simulationPosition: [0.5, 28.4, 0.5],
      renderPosition: [0.5, 28.4, 0.5],
      avatarPosition: [0.5, 28.4, 0.5],
      renderQuaternion: [0, 0, 0, 1],
      facingTargetErrorDegrees: null,
      avatarReady: true,
      ndcPosition: [2.5, 1.8, 1.5],
      ndcHeadPosition: null,
      insideCombatArena: false,
      insideAssignedCombatArena: null,
      cameraLineOfSight: null,
      visible: false,
      active: true,
    }));
    const idleState = state({
      cycle: {
        cycleId: "",
        phase: "IDLE",
        arenaPositions: null,
      },
    });
    const idleScene = scene({
      cycleId: "",
      phase: "IDLE",
      agents: hiddenPreviewAgents,
      arenaSpawnSeparationXZ: null,
      renderedSeparationXZ: 0,
      camera: {
        position: [350, 8, 394],
        fov: 50,
        aspect: 16 / 9,
        targetId: "streaming-arena-anchor",
        expectedTargetId: "agent-a",
      },
    });

    expect(
      evaluateDuelSceneCapture(idleScene, idleState, 10_500),
    ).toMatchObject({ ok: true, issues: [] });
    expect(
      evaluateDuelSceneCapture(
        {
          ...idleScene,
          agents: [
            { ...hiddenPreviewAgents[0], avatarReady: false },
            hiddenPreviewAgents[1],
          ],
          camera: {
            ...(idleScene.camera as Record<string, unknown>),
            targetId: "agent-a",
          },
        },
        idleState,
        10_500,
      ).issues,
    ).toEqual(
      expect.arrayContaining(["camera_target_lost", "agent1_avatar_not_ready"]),
    );
  });

  it("reports rendered transform, visibility, framing, and camera defects", () => {
    const broken = scene({
      updatedAt: 7_000,
      arenaVisualsReady: false,
      agents: [
        {
          ...(scene().agents as Array<Record<string, unknown>>)[0],
          simulationPosition: [340, 0.42, 402],
          avatarPosition: [346, 0.42, 402],
          avatarReady: false,
          ndcPosition: [-1.5, 0.1, 0.5],
          insideCombatArena: false,
          visible: false,
        },
        (scene().agents as Array<Record<string, unknown>>)[1],
      ],
      camera: {
        ...(scene().camera as Record<string, unknown>),
        targetId: "agent-b",
      },
    });
    const evaluation = evaluateDuelSceneCapture(broken, state(), 10_500);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.issues).toEqual(
      expect.arrayContaining([
        "stale",
        "arena_visuals_not_ready",
        "camera_target_lost",
        "agent1_avatar_not_ready",
        "agent1_hidden",
        "agent1_outside_arena",
        "agent1_simulation_drift",
        "agent1_avatar_drift",
        "agent1_outside_view",
      ]),
    );
  });

  it("rejects missing or persistently wrong combat facing in a settled fight", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    const wrongFacing = scene({
      agents: [
        {
          ...agents[0],
          renderQuaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          facingTargetErrorDegrees: 180,
        },
        agents[1],
      ],
    });
    expect(
      evaluateDuelSceneCapture(wrongFacing, state(), 10_500).issues,
    ).toContain("agent1_combat_facing_error");

    const missingFacing = scene({
      agents: [
        {
          ...agents[0],
          renderQuaternion: null,
          facingTargetErrorDegrees: null,
        },
        agents[1],
      ],
    });
    expect(
      evaluateDuelSceneCapture(missingFacing, state(), 10_500).issues,
    ).toEqual(
      expect.arrayContaining([
        "agent1_rotation_missing",
        "agent1_combat_facing_missing",
      ]),
    );
  });

  it("rejects scene evidence that lies about its quaternion-derived facing error", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    expect(
      normalizeDuelSceneDiagnostics({
        ...scene(),
        agents: [
          {
            ...agents[0],
            renderQuaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
            facingTargetErrorDegrees: 0,
          },
          agents[1],
        ],
      }),
    ).toBeNull();
  });

  it("rejects overlap and internally inconsistent separation evidence", () => {
    const agents = scene().agents as Array<Record<string, unknown>>;
    const overlapping = scene({
      agents: [
        agents[0],
        {
          ...agents[1],
          simulationPosition: [348.2, 0.42, 402],
          renderPosition: [348.2, 0.42, 402],
          avatarPosition: [348.2, 0.42, 402],
        },
      ],
      renderedSeparationXZ: 0.2,
    });
    expect(
      evaluateDuelSceneCapture(overlapping, state(), 10_500).issues,
    ).toContain("agents_overlap");

    expect(
      normalizeDuelSceneDiagnostics({
        ...scene(),
        renderedSeparationXZ: 999,
      }),
    ).toBeNull();
  });
});
