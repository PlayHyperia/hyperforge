export type CaptureSceneAgentSlot = "agent1" | "agent2";

export type CaptureSceneReadinessDiagnostics = {
  ready: boolean;
  cycleId: string | null;
  phase: string | null;
  equipmentVisualsReady: boolean;
  equipmentConfigured: boolean;
  equipmentCycleId: string | null;
  equipmentRequiredCount: number;
  equipmentRequiredPlayerCount: number;
  equipmentReadyCount: number;
  equipmentExpectedPlayerCount: number;
  equipmentActiveVisualCount: number;
  equipmentActiveVisibleCount: number;
  equipmentActivePlayerCount: number;
  equipmentActiveVisiblePlayerCount: number;
  equipmentUnresolvedCount: number;
  equipmentAttachmentMismatchCount: number;
  expectedAgentCount: number;
  loadedExpectedAgentCount: number;
  visibleExpectedAgentCount: number;
  damagePresentationAvailable: boolean;
  activeDamageSplatCount: number | null;
  renderedAgentCount: number;
  renderedSeparationXZ: number | null;
  visibleAgentFramingCount: number;
  fullyFramedAgentSlots: CaptureSceneAgentSlot[];
  croppedVisibleAgentBodyCount: number;
  unobstructedVisibleAgentSlots: CaptureSceneAgentSlot[];
  occludedVisibleAgentBodyCount: number;
  missingVisibleAgentLineOfSightCount: number;
  minimumVisibleAgentHorizontalNdcSeparation: number | null;
  minimumVisibleAgentBodyNdcSpan: number | null;
  maximumVisibleAgentBodyNdcSpan: number | null;
  cameraFov: number | null;
  cameraRadius: number | null;
  cameraTargetSlot: CaptureSceneAgentSlot | null;
  cameraTargetMatchesExpected: boolean;
  preparationActive: boolean;
  preparationShotActive: boolean;
  preparationPairShotActive: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function boundedCounter(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(maximum, Math.floor(value));
}

function boundedNullableCounter(
  value: unknown,
  maximum: number,
): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return Math.min(maximum, value);
}

function boundedFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function finiteNdcPoint(value: unknown): { x: number; y: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = value[0];
  const y = value[1];
  return typeof x === "number" &&
    Number.isFinite(x) &&
    x >= -2 &&
    x <= 2 &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    y >= -2 &&
    y <= 2
    ? { x, y }
    : null;
}

function visibleAgentBodyFraming(value: unknown): {
  completeSpans: number[];
  completeHorizontalCenters: number[];
  completeSlots: CaptureSceneAgentSlot[];
  croppedCount: number;
} {
  const result = {
    completeSpans: [] as number[],
    completeHorizontalCenters: [] as number[],
    completeSlots: [] as CaptureSceneAgentSlot[],
    croppedCount: 0,
  };
  if (!Array.isArray(value)) return result;
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate) || candidate.visible !== true) continue;
    const root = finiteNdcPoint(candidate.ndcPosition);
    const head = finiteNdcPoint(candidate.ndcHeadPosition);
    if (!root || !head || head.y <= root.y) continue;
    // The preparation identity panel ends near +0.48 NDC and the lower status
    // card begins near -0.68 at the canonical 1280x720 render profile. Count
    // only complete bodies inside that vertical corridor and the established
    // 0.72 horizontal cinematic safe crop.
    const complete =
      Math.abs(root.x) <= 0.72 &&
      Math.abs(head.x) <= 0.72 &&
      head.y <= 0.48 &&
      root.y >= -0.68;
    if (complete) {
      const span = Math.round((head.y - root.y) * 1_000_000) / 1_000_000;
      if (span > 0 && span <= 2) {
        result.completeSpans.push(span);
        result.completeHorizontalCenters.push((root.x + head.x) * 0.5);
        if (index <= 1) {
          result.completeSlots.push(index === 0 ? "agent1" : "agent2");
        }
      }
      continue;
    }

    // A deliberate single-subject shot may place the other contestant fully
    // offscreen. Reject only a body that intersects the visible frame but is
    // clipped by the viewport or either broadcast HUD corridor.
    const intersectsViewport =
      Math.min(root.x, head.x) <= 1 &&
      Math.max(root.x, head.x) >= -1 &&
      Math.min(root.y, head.y) <= 1 &&
      Math.max(root.y, head.y) >= -1;
    if (intersectsViewport) result.croppedCount += 1;
  }
  return result;
}

function visibleAgentLineOfSight(value: unknown): {
  unobstructedSlots: CaptureSceneAgentSlot[];
  occludedCount: number;
  missingCount: number;
} {
  const result = {
    unobstructedSlots: [] as CaptureSceneAgentSlot[],
    occludedCount: 0,
    missingCount: 0,
  };
  if (!Array.isArray(value)) return result;
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate) || candidate.visible !== true) continue;
    const lineOfSight = isRecord(candidate.cameraLineOfSight)
      ? candidate.cameraLineOfSight
      : null;
    if (
      lineOfSight?.head === true &&
      lineOfSight.torso === true &&
      lineOfSight.lowerBody === true
    ) {
      if (index <= 1) {
        result.unobstructedSlots.push(index === 0 ? "agent1" : "agent2");
      }
    } else if (
      lineOfSight?.head === false ||
      lineOfSight?.torso === false ||
      lineOfSight?.lowerBody === false
    ) {
      result.occludedCount += 1;
    } else {
      result.missingCount += 1;
    }
  }
  return result;
}

/**
 * Reduces the in-page renderer snapshot to the exact non-sensitive counters
 * needed by the stream verifier. Never persist agents, positions, asset URLs,
 * or any unknown browser-provided fields in the external RTMP status file.
 */
export function normalizeCaptureSceneReadinessDiagnostics(
  value: unknown,
): CaptureSceneReadinessDiagnostics | null {
  if (!isRecord(value)) return null;
  const equipment = isRecord(value.equipmentVisuals)
    ? value.equipmentVisuals
    : null;
  const camera = isRecord(value.camera) ? value.camera : null;
  const visibleBodyFraming = visibleAgentBodyFraming(value.agents);
  const visibleLineOfSight = visibleAgentLineOfSight(value.agents);
  const visibleBodySpans = visibleBodyFraming.completeSpans;
  const visibleBodyHorizontalCenters =
    visibleBodyFraming.completeHorizontalCenters;
  const horizontalSeparations = visibleBodyHorizontalCenters.flatMap(
    (center, index) =>
      visibleBodyHorizontalCenters
        .slice(index + 1)
        .map(
          (otherCenter) =>
            Math.round(Math.abs(center - otherCenter) * 1_000_000) / 1_000_000,
        ),
  );
  const renderedAgentCount = Array.isArray(value.agents)
    ? value.agents.filter(
        (candidate) =>
          isRecord(candidate) && Array.isArray(candidate.renderPosition),
      ).length
    : 0;
  const targetId = boundedText(camera?.targetId, 128);
  const expectedTargetId = boundedText(camera?.expectedTargetId, 128);
  const agentIds = Array.isArray(value.agents)
    ? value.agents
        .slice(0, 2)
        .map((candidate) =>
          isRecord(candidate) ? boundedText(candidate.id, 128) : null,
        )
    : [];
  const targetSlot: CaptureSceneAgentSlot | null =
    targetId && targetId === agentIds[0]
      ? "agent1"
      : targetId && targetId === agentIds[1]
        ? "agent2"
        : null;
  const expectedTargetSlot: CaptureSceneAgentSlot | null =
    expectedTargetId && expectedTargetId === agentIds[0]
      ? "agent1"
      : expectedTargetId && expectedTargetId === agentIds[1]
        ? "agent2"
        : null;
  return {
    ready: value.ready === true,
    cycleId: boundedText(value.cycleId, 128),
    phase: boundedText(value.phase, 32),
    equipmentVisualsReady: value.equipmentVisualsReady === true,
    equipmentConfigured: equipment?.configured === true,
    equipmentCycleId: boundedText(equipment?.cycleId, 128),
    equipmentRequiredCount: boundedCounter(equipment?.requiredCount, 10_000),
    equipmentRequiredPlayerCount: boundedCounter(
      equipment?.requiredPlayerCount,
      64,
    ),
    equipmentReadyCount: boundedCounter(equipment?.readyCount, 10_000),
    equipmentExpectedPlayerCount: boundedCounter(
      equipment?.expectedPlayerCount,
      64,
    ),
    equipmentActiveVisualCount: boundedCounter(
      equipment?.activeVisualCount,
      10_000,
    ),
    equipmentActiveVisibleCount: boundedCounter(
      equipment?.activeVisibleCount,
      10_000,
    ),
    equipmentActivePlayerCount: boundedCounter(
      equipment?.activePlayerCount,
      64,
    ),
    equipmentActiveVisiblePlayerCount: boundedCounter(
      equipment?.activeVisiblePlayerCount,
      64,
    ),
    equipmentUnresolvedCount: boundedCounter(
      Array.isArray(equipment?.unresolved)
        ? equipment.unresolved.length
        : undefined,
      10_000,
    ),
    equipmentAttachmentMismatchCount: boundedCounter(
      Array.isArray(equipment?.attachmentMismatches)
        ? equipment.attachmentMismatches.length
        : undefined,
      10_000,
    ),
    expectedAgentCount: boundedCounter(value.expectedAgentCount, 64),
    loadedExpectedAgentCount: boundedCounter(
      value.loadedExpectedAgentCount,
      64,
    ),
    visibleExpectedAgentCount: boundedCounter(
      value.visibleExpectedAgentCount,
      64,
    ),
    damagePresentationAvailable: value.damagePresentationAvailable === true,
    activeDamageSplatCount: boundedNullableCounter(
      value.activeDamageSplatCount,
      10_000,
    ),
    renderedAgentCount: boundedCounter(renderedAgentCount, 64),
    renderedSeparationXZ: boundedFiniteNumber(
      value.renderedSeparationXZ,
      0,
      100_000,
    ),
    // Persist only aggregate scale evidence. Entity identities and projected
    // positions stay inside the browser. Relative pair slots prove broadcast
    // coverage without putting persistent character IDs in the status file.
    visibleAgentFramingCount: visibleBodySpans.length,
    fullyFramedAgentSlots: visibleBodyFraming.completeSlots,
    croppedVisibleAgentBodyCount: visibleBodyFraming.croppedCount,
    unobstructedVisibleAgentSlots: visibleLineOfSight.unobstructedSlots,
    occludedVisibleAgentBodyCount: visibleLineOfSight.occludedCount,
    missingVisibleAgentLineOfSightCount: visibleLineOfSight.missingCount,
    minimumVisibleAgentHorizontalNdcSeparation:
      horizontalSeparations.length > 0
        ? Math.min(...horizontalSeparations)
        : null,
    minimumVisibleAgentBodyNdcSpan:
      visibleBodySpans.length > 0 ? Math.min(...visibleBodySpans) : null,
    maximumVisibleAgentBodyNdcSpan:
      visibleBodySpans.length > 0 ? Math.max(...visibleBodySpans) : null,
    cameraFov: boundedFiniteNumber(camera?.fov, 1, 179),
    cameraRadius: boundedFiniteNumber(camera?.radius, 0, 100),
    cameraTargetSlot: targetSlot,
    cameraTargetMatchesExpected: Boolean(
      targetId &&
      expectedTargetId &&
      targetId === expectedTargetId &&
      targetSlot &&
      targetSlot === expectedTargetSlot,
    ),
    preparationActive: value.preparationActive === true,
    preparationShotActive: camera?.preparationShotActive === true,
    preparationPairShotActive: camera?.preparationPairShotActive === true,
  };
}
