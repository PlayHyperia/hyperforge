import { describe, expect, it } from "vitest";
import * as THREE from "../../../extras/three/three";
import {
  ClientCameraSystem,
  dampStreamingCinematicRadius,
  dampStreamingCinematicTheta,
  getStreamingArenaFocus,
  getStreamingAdaptiveFramingSeparation,
  getStreamingAspectFraming,
  hasAuthoritativeStreamingPreparation,
  getStreamingCinematicPhaseParams,
  getStreamingCanonicalPairFacingTheta,
  getStreamingCinematicLeadScale,
  getStreamingCinematicLosThetaOffsets,
  getStreamingCinematicLookAtHeight,
  getStreamingCinematicAngleDampingRate,
  getStreamingCinematicFacingTurnRate,
  getStreamingCinematicPositionDampingRate,
  getStreamingCinematicSeparationRadiusScale,
  getStreamingCinematicSideAngle,
  getStreamingCinematicTargetFov,
  getStreamingHorizontalSeparation,
  getStreamingPreparationCinematicParams,
  getStreamingPreparationPairRadiusBounds,
  getStreamingPreparationCameraTheta,
  getStreamingPreparationPairCameraTheta,
  getStreamingPreparationPairSideOnTheta,
  getStreamingPreparationSoloCameraTheta,
  getStreamingPreparationSeparationRadius,
  getStreamingResolutionArenaPair,
  getStreamingSeparationAwareRadius,
  isAuthoritativeStreamingPreparationPair,
  resolveStreamingEntityByIdentity,
  resolveStreamingEntityIdentity,
  resolveAuthoritativeStreamingPreparationOpponentId,
  resolveStreamingPreparationCameraActorId,
  resolveStreamingCinematicTheta,
  shouldFrameStreamingPreparationOpponent,
  shouldHoldStreamingArenaCamera,
  shouldUseStreamingResolutionLivePositions,
  type StreamingCinematicPhase,
} from "../ClientCameraSystem";

describe("streaming cinematic framing", () => {
  it("keeps the preparation lens through the authoritative public ready hold", () => {
    const state = {
      cycle: {
        phase: "IDLE" as const,
        agent1: { id: "agent-1" },
        agent2: { id: "agent-2" },
      },
      preparation: {
        status: "ready",
        agent1: { id: "agent-1" },
        agent2: { id: "agent-2" },
      },
    };

    expect(hasAuthoritativeStreamingPreparation(state)).toBe(true);
    expect(
      hasAuthoritativeStreamingPreparation({
        ...state,
        preparation: { ...state.preparation, status: "preparing" },
      }),
    ).toBe(true);
    expect(
      hasAuthoritativeStreamingPreparation({
        ...state,
        preparation: {
          ...state.preparation,
          agent2: { id: "stale-agent" },
        },
      }),
    ).toBe(false);
    expect(
      hasAuthoritativeStreamingPreparation({
        ...state,
        cycle: { ...state.cycle, phase: "ANNOUNCEMENT" },
      }),
    ).toBe(false);
    expect(
      isAuthoritativeStreamingPreparationPair(state, "agent-1", "agent-2"),
    ).toBe(true);
    expect(
      isAuthoritativeStreamingPreparationPair(state, "agent-2", "agent-1"),
    ).toBe(true);
    expect(
      isAuthoritativeStreamingPreparationPair(
        state,
        "agent-1",
        "unrelated-agent",
      ),
    ).toBe(false);
    expect(
      isAuthoritativeStreamingPreparationPair(
        { ...state, preparation: null },
        "agent-1",
        "agent-2",
      ),
    ).toBe(false);
    expect(
      resolveAuthoritativeStreamingPreparationOpponentId(state, "agent-1"),
    ).toBe("agent-2");
    expect(
      resolveAuthoritativeStreamingPreparationOpponentId(state, "agent-2"),
    ).toBe("agent-1");
    expect(
      resolveAuthoritativeStreamingPreparationOpponentId(
        { ...state, preparation: null },
        "agent-1",
      ),
    ).toBeNull();
  });

  it("honors only authoritative broadcast cuts within the preparation pair", () => {
    const participants = ["agent-1", "agent-2"];
    expect(
      resolveStreamingPreparationCameraActorId(
        { cameraTarget: "agent-2" },
        participants,
        "agent-1",
      ),
    ).toBe("agent-2");
    expect(
      resolveStreamingPreparationCameraActorId(
        { cameraTarget: "bystander" },
        participants,
        "agent-1",
      ),
    ).toBe("agent-1");
    expect(
      resolveStreamingPreparationCameraActorId(
        { cameraTarget: null },
        participants,
        null,
      ),
    ).toBe("agent-1");
    expect(
      resolveStreamingPreparationCameraActorId(null, [], "agent-1"),
    ).toBeNull();
  });

  it("binds cinematic participants by persistent character identity", () => {
    expect(
      resolveStreamingEntityIdentity({
        id: "runtime-top-level",
        characterId: "character-top-level",
        data: {
          id: "runtime-data",
          characterId: "character-data",
        },
      }),
    ).toBe("character-data");
    expect(
      resolveStreamingEntityIdentity({
        id: "runtime-top-level",
        characterId: "character-top-level",
      }),
    ).toBe("character-top-level");
    expect(
      resolveStreamingEntityIdentity({ data: { id: "runtime-data" } }),
    ).toBe("runtime-data");
    expect(resolveStreamingEntityIdentity(null)).toBeNull();
  });

  it("finds a persistent duel participant inside runtime-keyed client maps", () => {
    const agent = {
      id: "runtime-agent-2",
      data: {
        id: "runtime-agent-2",
        characterId: "persistent-agent-2",
      },
    };
    const players = new Map<string, unknown>([[agent.id, agent]]);
    const entities = {
      get: (id: string) => players.get(id),
      values: () => [][Symbol.iterator](),
      players,
      items: new Map<string, unknown>(),
    };

    expect(
      resolveStreamingEntityByIdentity(entities, "persistent-agent-2"),
    ).toBe(agent);
    expect(resolveStreamingEntityByIdentity(entities, agent.id)).toBe(agent);
    expect(resolveStreamingEntityByIdentity(entities, "missing-agent")).toBe(
      null,
    );
  });

  it("holds only anonymous idle broadcasts at the ring", () => {
    expect(shouldHoldStreamingArenaCamera("IDLE", false)).toBe(true);
    expect(shouldHoldStreamingArenaCamera("IDLE", false, null, true)).toBe(
      false,
    );
    expect(
      shouldHoldStreamingArenaCamera("IDLE", false, null, false, true),
    ).toBe(false);
    expect(shouldHoldStreamingArenaCamera("ANNOUNCEMENT", false, null)).toBe(
      true,
    );
    expect(
      shouldHoldStreamingArenaCamera("ANNOUNCEMENT", false, {
        agent1: [350, 24, 398],
        agent2: [350, 24, 414],
      }),
    ).toBe(false);
    expect(shouldHoldStreamingArenaCamera("FIGHTING", false)).toBe(false);
    expect(shouldHoldStreamingArenaCamera("IDLE", true)).toBe(false);
  });

  it("holds the inter-cycle camera at the authoritative arena midpoint", () => {
    expect(
      getStreamingArenaFocus({
        agent1: [350.5, 24.25, 398.5],
        agent2: [350.5, 24.25, 414.5],
      }),
    ).toEqual({ x: 350.5, y: 24.25, z: 406.5 });
  });

  it("pins either resolution actor to immutable arena coordinates during cleanup", () => {
    const positions = {
      agent1: [350.5, 24.25, 405.35] as [number, number, number],
      agent2: [350.5, 24.25, 406.65] as [number, number, number],
    };
    expect(
      getStreamingResolutionArenaPair(
        "RESOLUTION",
        positions,
        "agent-1",
        "agent-2",
        "agent-1",
      ),
    ).toEqual({ actor: positions.agent1, opponent: positions.agent2 });
    expect(
      getStreamingResolutionArenaPair(
        "RESOLUTION",
        positions,
        "agent-1",
        "agent-2",
        "agent-2",
      ),
    ).toEqual({ actor: positions.agent2, opponent: positions.agent1 });
    expect(
      getStreamingResolutionArenaPair(
        "FIGHTING",
        positions,
        "agent-1",
        "agent-2",
        "agent-1",
      ),
    ).toBeNull();
    expect(
      getStreamingResolutionArenaPair(
        "RESOLUTION",
        positions,
        "agent-1",
        "agent-2",
        "unrelated-agent",
      ),
    ).toBeNull();
  });

  it("keeps a resolution shot on the contestants' live final arena positions", () => {
    expect(
      shouldUseStreamingResolutionLivePositions(
        "RESOLUTION",
        { x: 343.5, y: 24.25, z: 414.5 },
        { x: 342.5, y: 24.25, z: 411.5 },
      ),
    ).toBe(true);
    expect(
      shouldUseStreamingResolutionLivePositions(
        "RESOLUTION",
        { x: 350.5, y: 24.25, z: 405.5 },
        { x: 0.5, y: 28.4, z: 0.5 },
      ),
    ).toBe(false);
    expect(
      shouldUseStreamingResolutionLivePositions(
        "FIGHTING",
        { x: 343.5, y: 24.25, z: 414.5 },
        { x: 342.5, y: 24.25, z: 411.5 },
      ),
    ).toBe(false);
  });

  it("falls back to the center of arena one before positions arrive", () => {
    expect(getStreamingArenaFocus(null)).toEqual({
      x: 350,
      y: 0.42,
      z: 406,
    });
  });

  it("preserves enough live fighting room for legal contestant movement", () => {
    const countdown = getStreamingCinematicPhaseParams("COUNTDOWN");
    const fighting = getStreamingCinematicPhaseParams("FIGHTING");

    expect(countdown.radiusMin).toBe(7);
    expect(countdown.radiusMax).toBe(9);
    expect(countdown.targetFov).toBe(48);
    expect(fighting.radiusMin).toBe(5.5);
    expect(fighting.radiusMax).toBe(7.2);
    expect(fighting.targetFov).toBe(46);
    expect(getStreamingCinematicSeparationRadiusScale("FIGHTING")).toBe(1.1);
    expect(fighting.focusBias).toBe(0.5);
  });

  it("uses equal-depth side-on fighting framing without flattening presentation shots", () => {
    expect(getStreamingCinematicSideAngle("FIGHTING")).toBeCloseTo(Math.PI / 2);
    expect(getStreamingCinematicSideAngle("COUNTDOWN")).toBeCloseTo(
      Math.PI * 0.56,
    );
    expect(getStreamingCinematicSideAngle("RESOLUTION")).toBeCloseTo(
      Math.PI * 0.56,
    );
  });

  it("keeps pair-facing orientation stable when the director switches contestants", () => {
    const agent1Position = new THREE.Vector3(346.5, 24.175, 404.5);
    const agent2Position = new THREE.Vector3(350.5, 24.175, 407.5);
    const fromAgent1 = getStreamingCanonicalPairFacingTheta(
      agent1Position,
      agent2Position,
      "agent-1",
      "agent-1",
      "agent-2",
    );
    const fromAgent2 = getStreamingCanonicalPairFacingTheta(
      agent2Position,
      agent1Position,
      "agent-2",
      "agent-1",
      "agent-2",
    );

    expect(fromAgent2).toBeCloseTo(fromAgent1, 12);
    expect(fromAgent1).toBeCloseTo(Math.atan2(4, 3), 12);
  });

  it("centers live combat on the pair instead of leading only one contestant", () => {
    expect(getStreamingCinematicLeadScale("FIGHTING")).toBe(0);
    expect(getStreamingCinematicLeadScale("IDLE", true)).toBe(0);
    expect(getStreamingCinematicLeadScale("COUNTDOWN")).toBe(0.8);
    expect(getStreamingCinematicLeadScale("IDLE")).toBe(1.5);
  });

  it("aims live combat low enough to keep full bodies balanced under the HUD", () => {
    expect(getStreamingCinematicLookAtHeight("FIGHTING")).toBe(1.02);
    expect(getStreamingCinematicLookAtHeight("IDLE", true)).toBe(0.96);
    expect(getStreamingCinematicLookAtHeight("IDLE", true, 0.25)).toBe(0.96);
    expect(getStreamingCinematicLookAtHeight("IDLE", true, 0.5)).toBeCloseTo(
      0.84,
    );
    expect(getStreamingCinematicLookAtHeight("IDLE", true, 0.75)).toBeCloseTo(
      0.72,
    );
    expect(getStreamingCinematicLookAtHeight("IDLE", true, Number.NaN)).toBe(
      0.96,
    );
    expect(getStreamingCinematicLookAtHeight("COUNTDOWN")).toBe(1.12);
    expect(getStreamingCinematicLookAtHeight("RESOLUTION")).toBe(1.12);

    // At the exact radius and lens retained by the real full-3D failure, the
    // maximum uneven-terrain correction supplies more than five NDC points of
    // additional lower-HUD clearance beyond the first 0.14m correction.
    const retainedRadius = 5.252975249199189;
    const verticalFovRadians = (40 * Math.PI) / 180;
    const additionalClearanceNdc =
      Math.tan(Math.atan(0.1 / retainedRadius)) /
      Math.tan(verticalFovRadians * 0.5);
    expect(additionalClearanceNdc).toBeGreaterThan(0.05);
    expect(additionalClearanceNdc).toBeLessThan(0.06);
  });

  it("frames the announcement as an elevated staged two-shot", () => {
    const announcement = getStreamingCinematicPhaseParams("ANNOUNCEMENT");

    expect(announcement.radiusMin).toBe(7);
    expect(announcement.radiusMax).toBe(8.25);
    expect(announcement.basePhi).toBeCloseTo(Math.PI * 0.3);
    expect(announcement.targetFov).toBe(48);
  });

  it("keeps every active duel phase focused on readable contestants", () => {
    for (const phase of [
      "ANNOUNCEMENT",
      "COUNTDOWN",
      "FIGHTING",
      "RESOLUTION",
    ] as const) {
      const params = getStreamingCinematicPhaseParams(phase);
      expect(params.radiusMax).toBeLessThanOrEqual(9);
      expect(params.targetFov).toBeLessThanOrEqual(50);
    }

    const resolution = getStreamingCinematicPhaseParams("RESOLUTION");
    expect(resolution.radiusMin).toBe(6.75);
    expect(resolution.radiusMax).toBe(8.25);
    expect(resolution.targetFov).toBe(48);
  });

  it("uses a tighter, steadier two-agent shot during live preparation", () => {
    const preparation = getStreamingPreparationCinematicParams();
    const idle = getStreamingCinematicPhaseParams("IDLE");

    expect(preparation.radiusMin).toBe(5.15);
    expect(preparation.radiusMax).toBe(5.3);
    expect(preparation.radiusMax).toBeLessThan(idle.radiusMax);
    expect(preparation.basePhi).toBeCloseTo(Math.PI * 0.4);
    expect(preparation.targetFov).toBe(40);
    expect(preparation.orbitAmplitude).toBeLessThan(idle.orbitAmplitude);

    // Project the largest fully measured body from the first close live pass
    // into both edges of the corrected radius envelope. The following live HLS
    // run remains the final composition authority.
    const measuredNdcSpan = 0.799879;
    const measuredRadius = 3.8773179874234924;
    const projectedSpanAtMinimum =
      (measuredNdcSpan * measuredRadius) / preparation.radiusMin;
    const projectedSpanAtMaximum =
      (measuredNdcSpan * measuredRadius) / preparation.radiusMax;
    expect(projectedSpanAtMinimum).toBeGreaterThanOrEqual(0.55);
    expect(projectedSpanAtMinimum).toBeLessThanOrEqual(0.75);
    expect(projectedSpanAtMaximum).toBeGreaterThanOrEqual(0.55);
    expect(projectedSpanAtMaximum).toBeLessThanOrEqual(0.75);
  });

  it("moves a level close pair inward without violating the measured body envelope", () => {
    const levelPair = getStreamingPreparationPairRadiusBounds(0.2);
    const unevenPair = getStreamingPreparationPairRadiusBounds(0.75);

    expect(levelPair).toEqual({ radiusMin: 4.55, radiusMax: 4.6 });
    expect(unevenPair.radiusMin).toBeCloseTo(5.15);
    expect(unevenPair.radiusMax).toBeCloseTo(5.3);
    expect(getStreamingPreparationPairRadiusBounds(Number.NaN)).toEqual({
      radiusMin: 5.15,
      radiusMax: 5.3,
    });

    // The rejected live frame measured 0.208395 horizontal separation and a
    // 0.596095 maximum body span at radius 5.3. The level-pair envelope must
    // lift separation over the 0.24 readiness floor while retaining the body
    // inside the existing 0.55..0.75 acceptance range.
    const rejectedRadius = 5.3;
    const projectedSeparation =
      (0.208395 * rejectedRadius) / levelPair.radiusMax;
    const projectedBodySpan = (0.596095 * rejectedRadius) / levelPair.radiusMin;
    expect(projectedSeparation).toBeGreaterThanOrEqual(0.24);
    expect(projectedBodySpan).toBeGreaterThanOrEqual(0.55);
    expect(projectedBodySpan).toBeLessThanOrEqual(0.75);
  });

  it("uses spare body clearance to separate a close uneven preparation pair", () => {
    const rejectedRadius = 5.3;
    const rejectedHorizontalNdcSeparation = 0.214704;
    const rejectedMaximumBodyNdcSpan = 0.584294;
    const horizontalSpanAtUnitRadius =
      Math.tan((40 * Math.PI) / 360) * (16 / 9);
    const inferredHorizontalWorldSeparation =
      rejectedHorizontalNdcSeparation *
      rejectedRadius *
      horizontalSpanAtUnitRadius;
    const correctedRadius = getStreamingPreparationSeparationRadius(
      rejectedRadius,
      inferredHorizontalWorldSeparation,
      40,
      16 / 9,
    );
    const correctedHorizontalSeparation =
      inferredHorizontalWorldSeparation /
      (correctedRadius * horizontalSpanAtUnitRadius);
    const correctedMaximumBodySpan =
      (rejectedMaximumBodyNdcSpan * rejectedRadius) / correctedRadius;

    expect(correctedRadius).toBeGreaterThanOrEqual(4.25);
    expect(correctedRadius).toBeLessThan(rejectedRadius);
    expect(correctedHorizontalSeparation).toBeGreaterThanOrEqual(0.26);
    expect(correctedMaximumBodySpan).toBeGreaterThanOrEqual(0.55);
    expect(correctedMaximumBodySpan).toBeLessThanOrEqual(0.75);
  });

  it("bounds invalid preparation separation framing inputs", () => {
    expect(
      getStreamingPreparationSeparationRadius(5.3, Number.NaN, 40, 16 / 9),
    ).toBe(5.3);
    expect(getStreamingPreparationSeparationRadius(5.3, 0.1, 40, 16 / 9)).toBe(
      4.25,
    );
    expect(getStreamingPreparationSeparationRadius(4, 0.1, 40, 16 / 9)).toBe(4);
    expect(
      getStreamingPreparationSeparationRadius(Number.NaN, 1, 40, 16 / 9),
    ).toBe(0);
  });

  it("drops an impossible second preparation subject using the existing safe-crop envelope", () => {
    const preparation = getStreamingPreparationCinematicParams();

    expect(
      shouldFrameStreamingPreparationOpponent(
        3.5,
        preparation.targetFov,
        16 / 9,
        preparation.radiusMax,
      ),
    ).toBe(true);
    expect(
      shouldFrameStreamingPreparationOpponent(
        5,
        preparation.targetFov,
        16 / 9,
        preparation.radiusMax,
      ),
    ).toBe(false);

    expect(
      shouldFrameStreamingPreparationOpponent(
        10,
        preparation.targetFov,
        16 / 9,
        16,
      ),
    ).toBe(true);
    expect(
      shouldFrameStreamingPreparationOpponent(
        20,
        preparation.targetFov,
        16 / 9,
        16,
      ),
    ).toBe(false);
    expect(
      shouldFrameStreamingPreparationOpponent(
        5,
        preparation.targetFov,
        9 / 16,
        16,
      ),
    ).toBe(false);
    expect(
      shouldFrameStreamingPreparationOpponent(
        3.9,
        preparation.targetFov,
        9 / 16,
        16,
      ),
    ).toBe(true);
  });

  it("keeps uneven-terrain preparation fit decisions on the horizontal plane", () => {
    const horizontalSeparation = getStreamingHorizontalSeparation(
      { x: -12.5, z: -0.5 },
      { x: -11.5, z: -3.5 },
    );

    expect(horizontalSeparation).toBeCloseTo(Math.sqrt(10), 12);
    expect(
      shouldFrameStreamingPreparationOpponent(
        horizontalSeparation,
        40,
        16 / 9,
        5.3,
      ),
    ).toBe(true);
    // The same valid X/Z pair can occupy terrain levels whose full 3D
    // distance would falsely fail this horizontal camera-fit decision.
    expect(
      shouldFrameStreamingPreparationOpponent(
        Math.hypot(horizontalSeparation, 3),
        40,
        16 / 9,
        5.3,
      ),
    ).toBe(false);
  });

  it("places shoreline preparation cameras on the land side of the target", () => {
    const theta = getStreamingPreparationCameraTheta(
      { x: -0.375, z: -17.375 },
      { x: -1.5, z: -17.5 },
      0,
    );

    expect(theta).toBeGreaterThan(Math.PI * 0.45);
    expect(theta).toBeLessThan(Math.PI * 0.6);
    expect(getStreamingPreparationCameraTheta({ x: 1, z: 1 }, null, 0.75)).toBe(
      0.75,
    );
    expect(
      getStreamingPreparationCameraTheta(
        { x: 1, z: 1 },
        { x: 1.1, z: 1.1 },
        0.75,
      ),
    ).toBe(0.75);
  });

  it("keeps a distant non-framed contestant behind a solo preparation camera", () => {
    const actor = { x: 0, z: 0 };
    const distantContestant = { x: 0, z: 9.487 };
    const activityTarget = { x: -10, z: 0 };
    const theta = getStreamingPreparationSoloCameraTheta(
      actor,
      distantContestant,
      activityTarget,
      0.75,
    );
    const isolationTheta = 0;
    const isolationDelta = Math.atan2(
      Math.sin(theta - isolationTheta),
      Math.cos(theta - isolationTheta),
    );

    expect(Math.abs(isolationDelta)).toBeLessThanOrEqual(
      Math.PI / 18 + Number.EPSILON,
    );
    // At the retained 5.3 m lens radius and 9.487 m contestant separation,
    // negative forward depth places the non-framed body behind the camera
    // instead of leaving a partial silhouette at the viewport edge.
    expect(5.3 - 9.487 * Math.cos(isolationDelta)).toBeLessThan(0);
    expect(
      getStreamingPreparationSoloCameraTheta(actor, null, activityTarget, 0.75),
    ).toBe(getStreamingPreparationCameraTheta(actor, activityTarget, 0.75));
  });

  it("keeps contextual two-subject preparation shots close to side-on", () => {
    const sideOnTheta = -Math.PI + 0.02;
    const contextualTheta = getStreamingPreparationPairCameraTheta(
      { x: 0, z: 0 },
      { x: -10, z: 0 },
      sideOnTheta,
    );
    const delta = Math.atan2(
      Math.sin(contextualTheta - sideOnTheta),
      Math.cos(contextualTheta - sideOnTheta),
    );

    expect(Math.abs(delta)).toBeCloseTo(Math.PI / 18);
    expect(
      getStreamingPreparationPairCameraTheta({ x: 0, z: 0 }, null, sideOnTheta),
    ).toBe(sideOnTheta);
    expect(
      getStreamingPreparationPairCameraTheta(
        { x: 0, z: 0 },
        { x: -10, z: 0 },
        sideOnTheta,
        0,
      ),
    ).toBe(sideOnTheta);
    expect(getStreamingCinematicLosThetaOffsets(true)).toEqual([0]);
    expect(getStreamingCinematicLosThetaOffsets(false)).toEqual([
      0,
      0.35,
      -0.35,
      0.7,
      -0.7,
      1.05,
      -1.05,
      1.4,
      -1.4,
      1.75,
      -1.75,
      Math.PI,
    ]);
  });

  it("builds the preparation hold from the pair axis instead of the idle orbit", () => {
    const pairFacingTheta = -0.7;
    const exactSideOnTheta = pairFacingTheta + Math.PI * 0.5;
    const contextualSideOnTheta = getStreamingPreparationPairSideOnTheta(
      pairFacingTheta,
      { x: 0, z: 0 },
      { x: 10, z: -4 },
    );
    const delta = Math.atan2(
      Math.sin(contextualSideOnTheta - exactSideOnTheta),
      Math.cos(contextualSideOnTheta - exactSideOnTheta),
    );

    expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI / 36 + Number.EPSILON);
    expect(
      getStreamingPreparationPairSideOnTheta(
        pairFacingTheta,
        { x: 0, z: 0 },
        null,
      ),
    ).toBe(exactSideOnTheta);
  });

  it("does not let preparation pair smoothing retain a depth-stacked angle", () => {
    const staleTheta = Math.PI * 0.5;
    const pairSideTheta = -Math.PI + 0.04;

    expect(
      resolveStreamingCinematicTheta(
        staleTheta,
        pairSideTheta,
        1.9,
        1 / 30,
        true,
      ),
    ).toBe(pairSideTheta);
    expect(
      resolveStreamingCinematicTheta(staleTheta, pairSideTheta, 1.9, 1 / 30),
    ).not.toBe(pairSideTheta);
    expect(
      resolveStreamingCinematicTheta(Math.PI - 0.01, -Math.PI + 0.01, 1, 1),
    ).toBeCloseTo(Math.PI + 0.01, 12);
  });

  it("defines bounded broadcast-safe parameters for every phase", () => {
    const phases: StreamingCinematicPhase[] = [
      "IDLE",
      "ANNOUNCEMENT",
      "COUNTDOWN",
      "FIGHTING",
      "RESOLUTION",
    ];

    for (const phase of phases) {
      const params = getStreamingCinematicPhaseParams(phase);
      expect(params.radiusMin).toBeGreaterThan(0);
      expect(params.radiusMax).toBeGreaterThan(params.radiusMin);
      expect(params.targetFov).toBeGreaterThanOrEqual(40);
      expect(params.targetFov).toBeLessThanOrEqual(60);
      expect(params.focusBias).toBeGreaterThanOrEqual(0);
      expect(params.focusBias).toBeLessThanOrEqual(1);
    }

    expect(getStreamingCinematicPhaseParams("FIGHTING").targetFov).toBe(46);
  });

  it("narrows the active-fight lens for hit punch-ins", () => {
    expect(getStreamingCinematicTargetFov("FIGHTING", 46, 0)).toBe(46);
    expect(getStreamingCinematicTargetFov("FIGHTING", 46, 1)).toBe(44.5);
    expect(getStreamingCinematicTargetFov("COUNTDOWN", 48, 1)).toBe(48);
    expect(getStreamingCinematicTargetFov("FIGHTING", 46, Number.NaN)).toBe(46);
    expect(getStreamingCinematicTargetFov("FIGHTING", Number.NaN, 0)).toBe(48);
  });

  it("preserves canonical framing at 16:9 and widens boundedly for narrow crops", () => {
    const landscape = getStreamingAspectFraming(9.5, 50, 16 / 9);
    const broadcastFourThree = getStreamingAspectFraming(9.5, 50, 4 / 3);
    const square = getStreamingAspectFraming(9.5, 50, 1);
    const portrait = getStreamingAspectFraming(9.5, 50, 9 / 16);

    expect(landscape).toEqual({ radius: 9.5, targetFov: 50 });
    expect(broadcastFourThree).toEqual(landscape);
    expect(square.radius).toBeGreaterThan(landscape.radius);
    expect(square.targetFov).toBeGreaterThan(landscape.targetFov);
    expect(portrait.radius).toBeGreaterThan(square.radius);
    expect(portrait.targetFov).toBeGreaterThan(square.targetFov);
    expect(portrait.radius).toBe(16);
    expect(portrait.targetFov).toBe(61);
  });

  it("keeps a nine-unit same-style matchup inside the 0.9 horizontal safe crop", () => {
    for (const aspect of [16 / 9, 1, 9 / 16]) {
      const framing = getStreamingAspectFraming(9.5, 50, aspect);
      const horizontalSpan =
        2 *
        framing.radius *
        Math.tan((framing.targetFov * Math.PI) / 360) *
        aspect;

      expect(horizontalSpan * 0.9).toBeGreaterThanOrEqual(9.5);
    }
  });

  it("pulls back only when exceptional separation would breach the safe crop", () => {
    const canonical = getStreamingSeparationAwareRadius(7.3, 5, 48, 4 / 3);
    const staged = getStreamingSeparationAwareRadius(7.3, 8.55, 48, 4 / 3);
    const stagedHorizontalNdc =
      8.55 / (2 * staged * Math.tan((48 * Math.PI) / 360) * (4 / 3));

    expect(canonical).toBe(7.3);
    expect(staged).toBeGreaterThan(canonical);
    expect(stagedHorizontalNdc).toBeLessThanOrEqual(0.6);
    expect(getStreamingSeparationAwareRadius(7.3, 100, 48, 4 / 3, 12)).toBe(12);
  });

  it("centers active combat faster than authored presentation shots", () => {
    expect(getStreamingCinematicPositionDampingRate("FIGHTING")).toBe(36);
    expect(getStreamingCinematicFacingTurnRate("FIGHTING")).toBe(6);
    expect(getStreamingCinematicAngleDampingRate("FIGHTING")).toBe(12);
    expect(getStreamingCinematicAngleDampingRate("IDLE", true)).toBe(12);
    for (const phase of [
      "IDLE",
      "ANNOUNCEMENT",
      "COUNTDOWN",
      "RESOLUTION",
    ] as const) {
      expect(getStreamingCinematicPositionDampingRate(phase)).toBe(5);
      expect(getStreamingCinematicFacingTurnRate(phase)).toBe(1.9);
      expect(getStreamingCinematicAngleDampingRate(phase)).toBe(3.5);
    }
  });

  it("tracks a moving preparation pair before IDLE smoothing can depth-stack it", () => {
    const frameSeconds = 1 / 30;
    const preparationAlpha =
      1 -
      Math.exp(
        -getStreamingCinematicAngleDampingRate("IDLE", true) * frameSeconds,
      );
    const ordinaryIdleAlpha =
      1 -
      Math.exp(-getStreamingCinematicAngleDampingRate("IDLE") * frameSeconds);

    expect(preparationAlpha).toBeGreaterThan(ordinaryIdleAlpha * 2.5);
    expect((1 - preparationAlpha) ** 5).toBeLessThan(0.14);
    expect((1 - ordinaryIdleAlpha) ** 5).toBeGreaterThan(0.5);
  });

  it("bounds the final preparation theta residual without removing damping", () => {
    const targetTheta = -Math.PI + 0.04;
    const maximumResidual = Math.PI / 18;
    const boundedTheta = dampStreamingCinematicTheta(
      Math.PI * 0.5,
      targetTheta,
      getStreamingCinematicAngleDampingRate("IDLE", true),
      1 / 30,
      maximumResidual,
    );
    const boundedResidual = Math.atan2(
      Math.sin(targetTheta - boundedTheta),
      Math.cos(targetTheta - boundedTheta),
    );
    const ordinaryTheta = dampStreamingCinematicTheta(
      Math.PI * 0.5,
      targetTheta,
      getStreamingCinematicAngleDampingRate("IDLE"),
      1 / 30,
    );
    const ordinaryResidual = Math.atan2(
      Math.sin(targetTheta - ordinaryTheta),
      Math.cos(targetTheta - ordinaryTheta),
    );

    expect(Math.abs(boundedResidual)).toBeLessThanOrEqual(maximumResidual);
    expect(Math.abs(boundedResidual)).toBeGreaterThan(0);
    expect(Math.abs(ordinaryResidual)).toBeGreaterThan(maximumResidual * 5);
    expect(dampStreamingCinematicTheta(Number.NaN, 0.5, 12, 1 / 30)).toBe(0.5);
    expect(dampStreamingCinematicTheta(0.5, Number.NaN, 12, 1 / 30)).toBe(0.5);
  });

  it("bounds invalid separation-aware framing inputs deterministically", () => {
    expect(getStreamingSeparationAwareRadius(7.3, Number.NaN, 48, 4 / 3)).toBe(
      7.3,
    );
    expect(
      getStreamingSeparationAwareRadius(7.3, 8.55, Number.NaN, null),
    ).toBeGreaterThanOrEqual(7.3);
    expect(getStreamingSeparationAwareRadius(7.3, 100, 48, 4 / 3, 5)).toBe(7.3);
  });

  it("expands immediately for kiting and releases framing room gradually", () => {
    const expanded = getStreamingAdaptiveFramingSeparation(2, 8, 1 / 60);
    expect(expanded).toBe(8);

    const firstRelease = getStreamingAdaptiveFramingSeparation(
      expanded,
      2,
      1 / 60,
    );
    expect(firstRelease).toBeLessThan(expanded);
    expect(firstRelease).toBeGreaterThan(7.9);

    let released = expanded;
    for (let frame = 0; frame < 120; frame += 1) {
      released = getStreamingAdaptiveFramingSeparation(released, 2, 1 / 60);
    }
    expect(released).toBeGreaterThan(2);
    expect(released).toBeLessThan(3);
  });

  it("pulls back quickly without snapping and pushes in more slowly", () => {
    const expanded = dampStreamingCinematicRadius(6.5, 9.5, 1 / 60);
    const contracted = dampStreamingCinematicRadius(9.5, 6.5, 1 / 60);

    expect(expanded).toBeGreaterThan(6.5);
    expect(expanded).toBeLessThan(9.5);
    expect(9.5 - expanded).toBeLessThan(contracted - 6.5);

    let radius = 6.5;
    for (let frame = 0; frame < 15; frame += 1) {
      radius = dampStreamingCinematicRadius(radius, 9.5, 1 / 60);
    }
    expect(radius).toBeGreaterThan(9.45);
  });

  it("keeps the smoothed two-subject look target centered without quaternion lag", () => {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    camera.position.set(9, 6, -4);
    camera.lookAt(new THREE.Vector3(100, 1, 100));
    camera.updateMatrixWorld(true);

    const lookAtTarget = new THREE.Vector3(1.5, 1.2, -2);
    const system = Object.create(ClientCameraSystem.prototype) as {
      camera: THREE.PerspectiveCamera;
      lookAtTarget: THREE.Vector3;
      applyCinematicLookDirection(): void;
    };
    system.camera = camera;
    system.lookAtTarget = lookAtTarget;
    system.applyCinematicLookDirection();
    camera.updateMatrixWorld(true);

    const projectedTarget = lookAtTarget.clone().project(camera);
    expect(projectedTarget.x).toBeCloseTo(0, 6);
    expect(projectedTarget.y).toBeCloseTo(0, 6);
  });

  it("reports real camera-to-contestant line of sight without moving the camera", () => {
    const camera = new THREE.PerspectiveCamera(47, 16 / 9, 0.1, 100);
    camera.position.set(0, 2, 0);
    const raycastHits: Array<{ distance: number } | null> = [
      null,
      { distance: 2 },
      { distance: 4.8 },
    ];
    const system = Object.create(ClientCameraSystem.prototype) as unknown as {
      camera: THREE.PerspectiveCamera;
      cinematicLosMask: number | null;
      world: {
        createLayerMask: (...layers: string[]) => number;
        raycast: () => { distance: number } | null;
      };
      getStreamingCinematicLineOfSight(target: {
        x: number;
        y: number;
        z: number;
      }): boolean | null;
    };
    system.camera = camera;
    system.cinematicLosMask = null;
    system.world = {
      createLayerMask: () => 1,
      raycast: () => raycastHits.shift() ?? null,
    };

    const target = { x: 0, y: 1, z: 5 };
    expect(system.getStreamingCinematicLineOfSight(target)).toBe(true);
    expect(system.getStreamingCinematicLineOfSight(target)).toBe(false);
    expect(system.getStreamingCinematicLineOfSight(target)).toBe(true);
    expect(camera.position.toArray()).toEqual([0, 2, 0]);
  });

  it("probes lower-body terrain visibility without contestant colliders", () => {
    const camera = new THREE.PerspectiveCamera(47, 16 / 9, 0.1, 100);
    camera.position.set(0, 2, 0);
    const requestedLayers: string[][] = [];
    const raycastMasks: number[] = [];
    let terrainHeight = 1.5;
    const system = Object.create(ClientCameraSystem.prototype) as unknown as {
      camera: THREE.PerspectiveCamera;
      cinematicCollisionMask: number | null;
      world: {
        createLayerMask: (...layers: string[]) => number;
        getSystem: (name: string) => unknown;
        raycast: (
          source: THREE.Vector3,
          direction: THREE.Vector3,
          distance: number,
          mask: number,
        ) => { distance: number } | null;
      };
      getStreamingCinematicEnvironmentLineOfSight(target: {
        x: number;
        y: number;
        z: number;
      }): boolean | null;
    };
    system.camera = camera;
    system.cinematicCollisionMask = null;
    system.world = {
      createLayerMask: (...layers) => {
        requestedLayers.push(layers);
        return 7;
      },
      getSystem: (name) =>
        name === "terrain"
          ? { getHeightAt: () => terrainHeight, getNormalAt: () => ({}) }
          : null,
      raycast: (_source, _direction, _distance, mask) => {
        raycastMasks.push(mask);
        return null;
      },
    };

    expect(
      system.getStreamingCinematicEnvironmentLineOfSight({
        x: 0,
        y: 0.7,
        z: 5,
      }),
    ).toBe(false);
    terrainHeight = -10;
    expect(
      system.getStreamingCinematicEnvironmentLineOfSight({
        x: 0,
        y: 0.7,
        z: 5,
      }),
    ).toBe(true);
    expect(requestedLayers).toEqual([
      ["environment", "prop", "building", "obstacle"],
    ]);
    expect(raycastMasks).toEqual([7, 7]);
    expect(camera.position.toArray()).toEqual([0, 2, 0]);
  });

  it("clamps unsupported and invalid aspect measurements safely", () => {
    const minimum = getStreamingAspectFraming(9.5, 50, 9 / 16);

    expect(getStreamingAspectFraming(9.5, 50, 0.2)).toEqual(minimum);
    expect(getStreamingAspectFraming(9.5, 50, 0)).toEqual({
      radius: 9.5,
      targetFov: 50,
    });
    expect(getStreamingAspectFraming(9.5, 50, Number.NaN)).toEqual({
      radius: 9.5,
      targetFov: 50,
    });
    expect(getStreamingAspectFraming(9.5, 50, 32 / 9)).toEqual({
      radius: 9.5,
      targetFov: 50,
    });
  });
});
