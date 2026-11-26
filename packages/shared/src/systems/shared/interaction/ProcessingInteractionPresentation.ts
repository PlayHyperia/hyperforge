import type { World } from "../../../types";
import { EventType } from "../../../types/events";
import type {
  ProcessingInteractionPresentationState,
  ProcessingInteractionTargetPosition,
  ProcessingSkill,
} from "../../../types/game/processing-interaction-presentation";
import { normalizeProcessingInteractionPresentationState } from "../../../types/game/processing-interaction-presentation";

type PresentationEntity = {
  position?: Partial<ProcessingInteractionTargetPosition> | null;
  node?: {
    position?: Partial<ProcessingInteractionTargetPosition> | null;
  } | null;
  data?: Record<string, unknown>;
  markNetworkDirty?: () => void;
};

type PresentationWorld = World & {
  getPlayer?: (playerId: string) => PresentationEntity | undefined;
  $eventBus?: {
    emitEvent: (
      eventType: string,
      data: Record<string, unknown>,
      source: string,
    ) => void;
  };
};

const worldRevisions = new WeakMap<object, Map<string, number>>();
const worldStates = new WeakMap<
  object,
  Map<string, ProcessingInteractionPresentationState>
>();
const MAX_WORLD_COORDINATE = 1_000_000;

function finitePosition(
  value: Partial<ProcessingInteractionTargetPosition> | null | undefined,
): ProcessingInteractionTargetPosition | null {
  if (
    typeof value?.x !== "number" ||
    !Number.isFinite(value.x) ||
    Math.abs(value.x) > MAX_WORLD_COORDINATE ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    Math.abs(value.y) > MAX_WORLD_COORDINATE ||
    typeof value.z !== "number" ||
    !Number.isFinite(value.z) ||
    Math.abs(value.z) > MAX_WORLD_COORDINATE
  ) {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z };
}

function getPlayer(world: PresentationWorld, playerId: string) {
  return (
    world.getPlayer?.(playerId) ??
    (world.entities.get(playerId) as PresentationEntity | undefined)
  );
}

function nextRevision(
  world: PresentationWorld,
  playerId: string,
  player: PresentationEntity | undefined,
): number {
  let revisions = worldRevisions.get(world);
  if (!revisions) {
    revisions = new Map();
    worldRevisions.set(world, revisions);
  }
  const serialized = normalizeProcessingInteractionPresentationState(
    player?.data?.processingInteractionPresentation,
  )?.revision;
  const revision = Math.max(revisions.get(playerId) ?? 0, serialized ?? 0) + 1;
  revisions.set(playerId, revision);
  return revision;
}

function resolveTargetPosition(
  world: PresentationWorld,
  targetEntityId: string | null | undefined,
  explicitPosition:
    Partial<ProcessingInteractionTargetPosition> | null | undefined,
): ProcessingInteractionTargetPosition | null {
  const explicit = finitePosition(explicitPosition);
  if (explicit) return explicit;
  const target = targetEntityId
    ? (world.entities.get(targetEntityId) as PresentationEntity | undefined)
    : undefined;
  return (
    finitePosition(target?.node?.position) ?? finitePosition(target?.position)
  );
}

function publishState(
  world: PresentationWorld,
  playerId: string,
  state: ProcessingInteractionPresentationState,
): ProcessingInteractionPresentationState {
  let states = worldStates.get(world);
  if (!states) {
    states = new Map();
    worldStates.set(world, states);
  }
  states.set(playerId, state);
  const player = getPlayer(world, playerId);
  if (player) {
    player.data ??= {};
    player.data.processingInteractionPresentation = state;
    player.markNetworkDirty?.();
  }
  const payload = {
    playerId,
    ...state,
  };
  if (world.$eventBus?.emitEvent) {
    world.$eventBus.emitEvent(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
      payload,
      "processing-presentation",
    );
  } else if (typeof world.emit === "function") {
    world.emit(EventType.PROCESSING_INTERACTION_PRESENTATION, payload);
  }
  return state;
}

/** Publish one validated public work phase and exact observable target. */
export function publishProcessingInteractionPresentation(
  world: World,
  params: {
    playerId: string;
    skill: ProcessingSkill;
    targetEntityId?: string | null;
    targetPosition?: Partial<ProcessingInteractionTargetPosition> | null;
  },
): ProcessingInteractionPresentationState {
  const presentationWorld = world as PresentationWorld;
  const player = getPlayer(presentationWorld, params.playerId);
  return publishState(presentationWorld, params.playerId, {
    revision: nextRevision(presentationWorld, params.playerId, player),
    skill: params.skill,
    phase: "working",
    phaseStartedAtServerTimeMs: performance.now(),
    targetPosition: resolveTargetPosition(
      presentationWorld,
      params.targetEntityId,
      params.targetPosition,
    ),
  });
}

/**
 * Clear only the family that still owns the public state. This prevents an
 * older terminal callback from erasing a newer validated action.
 */
export function clearProcessingInteractionPresentation(
  world: World,
  playerId: string,
  expectedSkill?: ProcessingSkill,
): ProcessingInteractionPresentationState | null {
  const presentationWorld = world as PresentationWorld;
  const player = getPlayer(presentationWorld, playerId);
  const current =
    normalizeProcessingInteractionPresentationState(
      player?.data?.processingInteractionPresentation,
    ) ??
    worldStates.get(presentationWorld)?.get(playerId) ??
    null;
  if (expectedSkill && current?.skill !== expectedSkill) return null;
  if (!current || current.phase === "idle") return current;
  return publishState(presentationWorld, playerId, {
    revision: nextRevision(presentationWorld, playerId, player),
    skill: null,
    phase: "idle",
    phaseStartedAtServerTimeMs: null,
    targetPosition: null,
  });
}
