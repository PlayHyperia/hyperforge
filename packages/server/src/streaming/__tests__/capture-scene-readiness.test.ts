import { describe, expect, it } from "vitest";

import { normalizeCaptureSceneReadinessDiagnostics } from "../capture-scene-readiness";

describe("capture scene-readiness diagnostics", () => {
  it("publishes fitted-equipment counters and identity-free framing scale", () => {
    const normalized = normalizeCaptureSceneReadinessDiagnostics({
      ready: true,
      cycleId: "cycle-1",
      phase: "FIGHTING",
      expectedAgentCount: 2,
      loadedExpectedAgentCount: 2,
      visibleExpectedAgentCount: 2,
      damagePresentationAvailable: true,
      activeDamageSplatCount: 3,
      renderedSeparationXZ: 3.25,
      preparationActive: true,
      equipmentVisualsReady: true,
      equipmentVisuals: {
        configured: true,
        cycleId: "cycle-1",
        requiredCount: 6,
        requiredPlayerCount: 2,
        readyCount: 6,
        expectedPlayerCount: 2,
        activeVisualCount: 2,
        activeVisibleCount: 2,
        activePlayerCount: 2,
        activeVisiblePlayerCount: 2,
        unresolved: [],
        attachmentMismatches: [],
        privateAssetUrl: "asset://must-not-leak.glb",
      },
      agents: [
        {
          id: "must-not-leak-1",
          visible: true,
          renderPosition: [10, 2, 20],
          ndcPosition: [-0.1, -0.3, 0.2],
          ndcHeadPosition: [-0.1, 0.24, 0.2],
          cameraLineOfSight: { head: true, torso: true, lowerBody: true },
        },
        {
          id: "must-not-leak-2",
          visible: true,
          renderPosition: [13.25, 2, 20],
          ndcPosition: [0.1, -0.28, 0.2],
          ndcHeadPosition: [0.1, 0.2, 0.2],
          cameraLineOfSight: { head: true, torso: true, lowerBody: true },
        },
      ],
      camera: {
        fov: 40,
        radius: 3.75,
        preparationShotActive: true,
        preparationPairShotActive: true,
        targetId: "must-not-leak-1",
        expectedTargetId: "must-not-leak-1",
        position: ["must-not-leak"],
      },
    });

    expect(normalized).toEqual({
      ready: true,
      cycleId: "cycle-1",
      phase: "FIGHTING",
      equipmentVisualsReady: true,
      equipmentConfigured: true,
      equipmentCycleId: "cycle-1",
      equipmentRequiredCount: 6,
      equipmentRequiredPlayerCount: 2,
      equipmentReadyCount: 6,
      equipmentExpectedPlayerCount: 2,
      equipmentActiveVisualCount: 2,
      equipmentActiveVisibleCount: 2,
      equipmentActivePlayerCount: 2,
      equipmentActiveVisiblePlayerCount: 2,
      equipmentUnresolvedCount: 0,
      equipmentAttachmentMismatchCount: 0,
      expectedAgentCount: 2,
      loadedExpectedAgentCount: 2,
      visibleExpectedAgentCount: 2,
      damagePresentationAvailable: true,
      activeDamageSplatCount: 3,
      renderedAgentCount: 2,
      renderedSeparationXZ: 3.25,
      visibleAgentFramingCount: 2,
      fullyFramedAgentSlots: ["agent1", "agent2"],
      croppedVisibleAgentBodyCount: 0,
      unobstructedVisibleAgentSlots: ["agent1", "agent2"],
      occludedVisibleAgentBodyCount: 0,
      missingVisibleAgentLineOfSightCount: 0,
      minimumVisibleAgentHorizontalNdcSeparation: 0.2,
      minimumVisibleAgentBodyNdcSpan: 0.48,
      maximumVisibleAgentBodyNdcSpan: 0.54,
      cameraFov: 40,
      cameraRadius: 3.75,
      cameraTargetSlot: "agent1",
      cameraTargetMatchesExpected: true,
      preparationActive: true,
      preparationShotActive: true,
      preparationPairShotActive: true,
    });
    expect(JSON.stringify(normalized)).not.toContain("must-not-leak");
    expect(normalized).not.toHaveProperty("agents");
  });

  it("fails closed for absent or malformed browser evidence", () => {
    expect(normalizeCaptureSceneReadinessDiagnostics(null)).toBeNull();
    expect(normalizeCaptureSceneReadinessDiagnostics([])).toBeNull();
    expect(
      normalizeCaptureSceneReadinessDiagnostics({
        ready: "true",
        equipmentVisuals: "invalid",
        expectedAgentCount: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({
      ready: false,
      equipmentVisualsReady: false,
      equipmentConfigured: false,
      equipmentRequiredCount: 0,
      expectedAgentCount: 0,
      loadedExpectedAgentCount: 0,
      visibleExpectedAgentCount: 0,
      damagePresentationAvailable: false,
      activeDamageSplatCount: null,
      renderedAgentCount: 0,
      renderedSeparationXZ: null,
      visibleAgentFramingCount: 0,
      fullyFramedAgentSlots: [],
      croppedVisibleAgentBodyCount: 0,
      unobstructedVisibleAgentSlots: [],
      occludedVisibleAgentBodyCount: 0,
      missingVisibleAgentLineOfSightCount: 0,
      minimumVisibleAgentHorizontalNdcSeparation: null,
      minimumVisibleAgentBodyNdcSpan: null,
      maximumVisibleAgentBodyNdcSpan: null,
      cameraFov: null,
      cameraRadius: null,
      cameraTargetSlot: null,
      cameraTargetMatchesExpected: false,
      preparationActive: false,
      preparationShotActive: false,
      preparationPairShotActive: false,
    });
  });

  it("rejects malformed projections and counts visible HUD or viewport crops", () => {
    expect(
      normalizeCaptureSceneReadinessDiagnostics({
        agents: [
          {
            visible: false,
            ndcPosition: [0, -0.3, 0],
            ndcHeadPosition: [0, 0.3, 0],
          },
          {
            visible: true,
            ndcPosition: [0, Number.NaN, 0],
            ndcHeadPosition: [0, 0.3, 0],
          },
          {
            visible: true,
            ndcPosition: [0, -0.3, 0],
            ndcHeadPosition: [0, 3, 0],
          },
          {
            visible: true,
            ndcPosition: [0.9, -0.3, 0],
            ndcHeadPosition: [0.9, 0.3, 0],
          },
          {
            visible: true,
            ndcPosition: [0, -1.2, 0],
            ndcHeadPosition: [0, -0.2, 0],
          },
          {
            visible: true,
            ndcPosition: [1.4, -0.3, 0],
            ndcHeadPosition: [1.4, 0.3, 0],
          },
        ],
      }),
    ).toMatchObject({
      visibleAgentFramingCount: 0,
      croppedVisibleAgentBodyCount: 2,
      unobstructedVisibleAgentSlots: [],
      occludedVisibleAgentBodyCount: 0,
      missingVisibleAgentLineOfSightCount: 5,
      minimumVisibleAgentHorizontalNdcSeparation: null,
      minimumVisibleAgentBodyNdcSpan: null,
      maximumVisibleAgentBodyNdcSpan: null,
    });
  });

  it("separates unobstructed, occluded, and missing line-of-sight evidence", () => {
    expect(
      normalizeCaptureSceneReadinessDiagnostics({
        agents: [
          {
            visible: true,
            cameraLineOfSight: { head: true, torso: true, lowerBody: true },
          },
          {
            visible: true,
            cameraLineOfSight: { head: true, torso: false, lowerBody: true },
          },
          {
            visible: true,
            cameraLineOfSight: {
              head: "yes",
              torso: true,
              lowerBody: true,
            },
          },
        ],
      }),
    ).toMatchObject({
      unobstructedVisibleAgentSlots: ["agent1"],
      occludedVisibleAgentBodyCount: 1,
      missingVisibleAgentLineOfSightCount: 1,
    });
  });

  it("does not certify a preparation body from head-and-torso evidence alone", () => {
    expect(
      normalizeCaptureSceneReadinessDiagnostics({
        agents: [
          {
            visible: true,
            cameraLineOfSight: { head: true, torso: true },
          },
        ],
      }),
    ).toMatchObject({
      unobstructedVisibleAgentSlots: [],
      occludedVisibleAgentBodyCount: 0,
      missingVisibleAgentLineOfSightCount: 1,
    });
  });

  it("bounds untrusted text, counters, and diagnostic arrays", () => {
    const result = normalizeCaptureSceneReadinessDiagnostics({
      cycleId: "c".repeat(200),
      phase: "p".repeat(80),
      expectedAgentCount: 1_000,
      damagePresentationAvailable: true,
      activeDamageSplatCount: 20_000,
      equipmentVisuals: {
        requiredCount: 20_000,
        unresolved: Array.from({ length: 10_001 }),
        attachmentMismatches: Array.from({ length: 10_002 }),
      },
    });

    expect(result?.cycleId).toHaveLength(128);
    expect(result?.phase).toHaveLength(32);
    expect(result?.expectedAgentCount).toBe(64);
    expect(result?.damagePresentationAvailable).toBe(true);
    expect(result?.activeDamageSplatCount).toBe(10_000);
    expect(result?.equipmentRequiredCount).toBe(10_000);
    expect(result?.equipmentUnresolvedCount).toBe(10_000);
    expect(result?.equipmentAttachmentMismatchCount).toBe(10_000);
  });

  it("distinguishes a real zero active-splat count from malformed evidence", () => {
    expect(
      normalizeCaptureSceneReadinessDiagnostics({
        damagePresentationAvailable: true,
        activeDamageSplatCount: 0,
      }),
    ).toMatchObject({
      damagePresentationAvailable: true,
      activeDamageSplatCount: 0,
    });
    expect(
      normalizeCaptureSceneReadinessDiagnostics({
        damagePresentationAvailable: true,
        activeDamageSplatCount: -1,
      }),
    ).toMatchObject({
      damagePresentationAvailable: true,
      activeDamageSplatCount: null,
    });
  });
});
