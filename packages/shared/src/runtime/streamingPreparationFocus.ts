import { normalizeProcessingInteractionPresentationState } from "../types/game/processing-interaction-presentation";

export type StreamingPreparationPhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

export type StreamingPreparationPosition = {
  x: number;
  y: number;
  z: number;
};

export type StreamingPreparationEntity = {
  id?: string;
  characterId?: string;
  position?: Partial<StreamingPreparationPosition> | null;
  node?: { position?: Partial<StreamingPreparationPosition> | null } | null;
  base?: { position?: Partial<StreamingPreparationPosition> | null } | null;
  data?: {
    id?: string;
    characterId?: string;
    gatheringToolPresentation?: {
      itemId?: unknown;
      revision?: unknown;
    } | null;
    fishingInteractionPresentation?: {
      phase?: unknown;
      itemId?: unknown;
      revision?: unknown;
      targetPosition?: Partial<StreamingPreparationPosition> | null;
    } | null;
    processingInteractionPresentation?: unknown;
  } | null;
};

export type StreamingPreparationParticipant = {
  id: string;
  entity: StreamingPreparationEntity;
  position: StreamingPreparationPosition;
};

export type StreamingPreparationFocus = {
  participants: readonly StreamingPreparationParticipant[];
  actorId: string;
  position: StreamingPreparationPosition;
  activityTargetPosition: StreamingPreparationPosition | null;
};

function finitePosition(
  value: Partial<StreamingPreparationPosition> | null | undefined,
): StreamingPreparationPosition | null {
  if (
    typeof value?.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.z !== "number" ||
    !Number.isFinite(value.z)
  ) {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z };
}

export function getStreamingPreparationEntityPosition(
  entity: StreamingPreparationEntity | null | undefined,
): StreamingPreparationPosition | null {
  if (!entity) return null;
  return (
    finitePosition(entity.node?.position) ??
    finitePosition(entity.position) ??
    finitePosition(entity.base?.position)
  );
}

/**
 * Preparation focus is driven by replicated authority state, never by a
 * guessed animation or client-only timer. A temporary gathering tool remains
 * published for the complete interaction, while the fishing phase supplies
 * the exact held/strike/recover presentation for late joiners.
 */
export function hasActiveStreamingPreparationPresentation(
  entity: StreamingPreparationEntity | null | undefined,
): boolean {
  const toolItemId = entity?.data?.gatheringToolPresentation?.itemId;
  const fishingPhase = entity?.data?.fishingInteractionPresentation?.phase;
  const processingState = normalizeProcessingInteractionPresentationState(
    entity?.data?.processingInteractionPresentation,
  );
  return (
    (typeof toolItemId === "string" && toolItemId.trim().length > 0) ||
    (typeof fishingPhase === "string" &&
      fishingPhase.length > 0 &&
      fishingPhase !== "idle") ||
    processingState?.phase === "working"
  );
}

/**
 * Resolve the exact assigned contestants who are visibly preparing between
 * duels. The signal is deliberately IDLE-only so cleanup and combat phases
 * cannot be pulled away from the authoritative arena composition.
 */
export function resolveStreamingPreparationFocus(params: {
  phase: StreamingPreparationPhase | string | null | undefined;
  participantIds: readonly (string | null | undefined)[];
  preferredActorId?: string | null;
  resolveEntity: (
    participantId: string,
  ) => StreamingPreparationEntity | null | undefined;
  isParticipantActive?: (
    participantId: string,
    entity: StreamingPreparationEntity,
  ) => boolean;
}): StreamingPreparationFocus | null {
  if (params.phase !== "IDLE") return null;

  const seen = new Set<string>();
  const participants: StreamingPreparationParticipant[] = [];
  for (const rawId of params.participantIds) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entity = params.resolveEntity(id);
    if (!entity) {
      continue;
    }
    const active = params.isParticipantActive
      ? params.isParticipantActive(id, entity)
      : hasActiveStreamingPreparationPresentation(entity);
    if (!active) {
      continue;
    }
    const position = getStreamingPreparationEntityPosition(entity);
    if (!position) continue;
    participants.push({ id, entity, position });
  }

  if (participants.length === 0) return null;
  const position = participants.reduce(
    (total, participant) => ({
      x: total.x + participant.position.x / participants.length,
      y: total.y + participant.position.y / participants.length,
      z: total.z + participant.position.z / participants.length,
    }),
    { x: 0, y: 0, z: 0 },
  );
  const preferredActor = participants.find(
    (participant) => participant.id === params.preferredActorId,
  );
  const actor = preferredActor ?? participants[0];
  const activityTargetParticipants = preferredActor
    ? [preferredActor]
    : participants;
  const activityTargets = activityTargetParticipants.flatMap((participant) => {
    const processingTarget = normalizeProcessingInteractionPresentationState(
      participant.entity.data?.processingInteractionPresentation,
    )?.targetPosition;
    const target =
      finitePosition(processingTarget) ??
      finitePosition(
        participant.entity.data?.fishingInteractionPresentation?.targetPosition,
      );
    return target ? [target] : [];
  });
  const activityTargetPosition =
    activityTargets.length > 0
      ? activityTargets.reduce(
          (total, target) => ({
            x: total.x + target.x / activityTargets.length,
            y: total.y + target.y / activityTargets.length,
            z: total.z + target.z / activityTargets.length,
          }),
          { x: 0, y: 0, z: 0 },
        )
      : null;

  return {
    participants,
    actorId: actor.id,
    position,
    activityTargetPosition,
  };
}
