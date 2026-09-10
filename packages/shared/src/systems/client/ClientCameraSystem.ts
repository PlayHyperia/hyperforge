/**
 * Core Camera System
 * camera system that supports multiple control modes:
 * - First Person (pointer lock, WASD movement)
 * - Third Person/MMO(right-click drag, click-to-move)
 * - Top-down/RTS (pan, zoom, click-to-move)
 */

import * as THREE from "../../extras/three/three";
import { SystemBase } from "../shared/infrastructure/SystemBase";

import type { CameraTarget, System, World } from "../../types";
import { EventType } from "../../types/events";
import { clamp } from "../../utils";
import {
  isEmbeddedSpectatorViewport,
  isStreamPageRoute,
} from "../../runtime/clientViewportMode";
import {
  hasActiveStreamingPreparationPresentation,
  resolveStreamingPreparationFocus,
  type StreamingPreparationEntity,
  type StreamingPreparationFocus,
  type StreamingPreparationPosition,
} from "../../runtime/streamingPreparationFocus";
import {
  getDuelArenaConfig,
  isPositionInsideCombatArena,
} from "../../data/duel-manifest";
import { RaycastService } from "./interaction/services/RaycastService";
// CameraTarget interface moved to shared types

// Define TerrainSystem interface for type checking
interface TerrainSystem extends System {
  getHeightAt(x: number, z: number): number;
  getNormalAt(x: number, z: number): { x: number; y: number; z: number };
}

export interface StreamingArenaPositions {
  agent1: [number, number, number];
  agent2: [number, number, number];
}

export interface StreamingCameraStateUpdate {
  cameraTarget?: string | null;
  cycle?: {
    phase?: "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";
    agent1?: {
      id?: string | null;
      hp?: number | null;
      maxHp?: number | null;
    } | null;
    agent2?: {
      id?: string | null;
      hp?: number | null;
      maxHp?: number | null;
    } | null;
    winnerId?: string | null;
    arenaPositions?: StreamingArenaPositions | null;
  };
  preparation?: {
    status?: "preparing" | "ready" | string;
    agent1?: { id?: string | null } | null;
    agent2?: { id?: string | null } | null;
  } | null;
}

/**
 * Keep the authored preparation lens for the complete public preparation
 * lifecycle. Tool/processing presentation is intentionally transient and may
 * finish before the scheduler's public ready hold; it can enrich the shot but
 * must never decide whether the selected preparation still exists.
 */
export function hasAuthoritativeStreamingPreparation(
  state: StreamingCameraStateUpdate | null | undefined,
): boolean {
  const cycle = state?.cycle;
  const preparation = state?.preparation;
  if (
    cycle?.phase !== "IDLE" ||
    (preparation?.status !== "preparing" && preparation?.status !== "ready")
  ) {
    return false;
  }
  const cycleAgent1Id = cycle.agent1?.id;
  const cycleAgent2Id = cycle.agent2?.id;
  const preparationAgent1Id = preparation.agent1?.id;
  const preparationAgent2Id = preparation.agent2?.id;
  return Boolean(
    cycleAgent1Id &&
    cycleAgent2Id &&
    preparationAgent1Id === cycleAgent1Id &&
    preparationAgent2Id === cycleAgent2Id,
  );
}

/**
 * Keep only the exact published preparation contestants paired after their
 * transient gathering/processing presentation ends. A ready hold is still an
 * authoritative two-subject shot; unrelated combat targets or bystanders must
 * not gain camera authority from the broader IDLE phase.
 */
export function isAuthoritativeStreamingPreparationPair(
  state: StreamingCameraStateUpdate | null | undefined,
  actorId: string | null | undefined,
  opponentId: string | null | undefined,
): boolean {
  if (
    !actorId ||
    !opponentId ||
    actorId === opponentId ||
    !hasAuthoritativeStreamingPreparation(state)
  ) {
    return false;
  }

  const agent1Id = state?.preparation?.agent1?.id;
  const agent2Id = state?.preparation?.agent2?.id;
  return (
    (actorId === agent1Id && opponentId === agent2Id) ||
    (actorId === agent2Id && opponentId === agent1Id)
  );
}

export function resolveAuthoritativeStreamingPreparationOpponentId(
  state: StreamingCameraStateUpdate | null | undefined,
  actorId: string | null | undefined,
): string | null {
  if (!actorId || !hasAuthoritativeStreamingPreparation(state)) return null;
  const agent1Id = state?.preparation?.agent1?.id ?? null;
  const agent2Id = state?.preparation?.agent2?.id ?? null;
  if (actorId === agent1Id) return agent2Id;
  if (actorId === agent2Id) return agent1Id;
  return null;
}

/**
 * Honor the server broadcast director's exact preparation cut while keeping a
 * stable local fallback before that target arrives. The published target is
 * accepted only when it belongs to the authoritative two-contestant pair.
 */
export function resolveStreamingPreparationCameraActorId(
  state: StreamingCameraStateUpdate | null | undefined,
  participantIds: readonly string[],
  currentTargetId: string | null | undefined,
): string | null {
  const directedTarget = state?.cameraTarget;
  if (
    typeof directedTarget === "string" &&
    participantIds.includes(directedTarget)
  ) {
    return directedTarget;
  }
  if (currentTargetId && participantIds.includes(currentTargetId)) {
    return currentTargetId;
  }
  return participantIds[0] ?? null;
}

/**
 * Streaming cycle participants are addressed by persistent character IDs.
 * Client entities may also expose a runtime/network ID; that identifier must
 * never outrank the character ID when the cinematic director binds a cycle.
 */
export function resolveStreamingEntityIdentity(entity: unknown): string | null {
  if (!entity || typeof entity !== "object") return null;
  const data = entity as {
    id?: string;
    characterId?: string;
    data?: { id?: string; characterId?: string };
  };
  for (const candidate of [
    data.data?.characterId,
    data.characterId,
    data.data?.id,
    data.id,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

type StreamingEntityCollection = {
  get?: (id: string) => unknown;
  values?: () => IterableIterator<unknown>;
};

type StreamingEntityRegistry = StreamingEntityCollection & {
  players?: StreamingEntityCollection;
  items?: StreamingEntityCollection;
  getAllEntities?: () => StreamingEntityCollection;
};

/**
 * Resolve a cycle participant even when the client registry is keyed by a
 * transient network ID. Duel authority publishes persistent character IDs,
 * so every available collection must fall back to identity comparison rather
 * than assuming its map key shares the authority namespace.
 */
export function resolveStreamingEntityByIdentity(
  entities: StreamingEntityRegistry | null | undefined,
  entityId: string,
): unknown | null {
  if (!entities || typeof entityId !== "string" || entityId.length === 0) {
    return null;
  }

  const collections: StreamingEntityCollection[] = [
    entities,
    ...(entities.players ? [entities.players] : []),
    ...(entities.items ? [entities.items] : []),
  ];
  const allEntities = entities.getAllEntities?.();
  if (allEntities) collections.push(allEntities);

  for (const collection of collections) {
    const direct = collection.get?.(entityId);
    if (direct) return direct;
  }
  for (const collection of collections) {
    if (!collection.values) continue;
    for (const entity of collection.values()) {
      if (resolveStreamingEntityIdentity(entity) === entityId) return entity;
    }
  }
  return null;
}

export interface StreamingArenaFocus {
  x: number;
  y: number;
  z: number;
}

export function hasValidStreamingArenaPositions(
  arenaPositions: StreamingArenaPositions | null | undefined,
): arenaPositions is StreamingArenaPositions {
  const first = arenaPositions?.agent1;
  const second = arenaPositions?.agent2;
  return Boolean(
    first &&
    second &&
    first.length >= 3 &&
    second.length >= 3 &&
    Number.isFinite(first[0]) &&
    Number.isFinite(first[1]) &&
    Number.isFinite(first[2]) &&
    Number.isFinite(second[0]) &&
    Number.isFinite(second[1]) &&
    Number.isFinite(second[2]),
  );
}

export function shouldHoldStreamingArenaCamera(
  phase: StreamingCinematicPhase | undefined,
  dashboardFollowMode: boolean,
  arenaPositions?: StreamingArenaPositions | null,
  hasActivePreparation = false,
  hasAuthoritativeIdleTarget = false,
): boolean {
  return (
    !dashboardFollowMode &&
    ((phase === "IDLE" &&
      !hasActivePreparation &&
      !hasAuthoritativeIdleTarget) ||
      (phase === "ANNOUNCEMENT" &&
        !hasValidStreamingArenaPositions(arenaPositions)))
  );
}

/**
 * Resolve a stable broadcast focus for the duel ring. Active-cycle spawn
 * positions are authoritative and include the terrain-adjusted Y coordinate.
 * Before the first cycle reaches the arena, fall back to arena one.
 */
export function getStreamingArenaFocus(
  arenaPositions: StreamingArenaPositions | null | undefined,
): StreamingArenaFocus {
  if (hasValidStreamingArenaPositions(arenaPositions)) {
    const first = arenaPositions.agent1;
    const second = arenaPositions.agent2;
    return {
      x: (first[0] + second[0]) / 2,
      y: (first[1] + second[1]) / 2,
      z: (first[2] + second[2]) / 2,
    };
  }

  const config = getDuelArenaConfig();
  return {
    x: config.baseX + config.arenaWidth / 2,
    y: config.baseY,
    z: config.baseZ + config.arenaLength / 2,
  };
}

export interface StreamingResolutionArenaPair {
  actor: [number, number, number];
  opponent: [number, number, number];
}

export interface StreamingCameraPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Keep the result camera on the fighters where the fight actually ended. The
 * server deliberately leaves both contestants in the ring for the full result
 * phase so the final combat composition remains visible. Only abandon those
 * transforms after cleanup has moved either contestant out of a combat arena.
 */
export function shouldUseStreamingResolutionLivePositions(
  phase: StreamingCinematicPhase | undefined,
  actorPosition: StreamingCameraPosition | null | undefined,
  opponentPosition: StreamingCameraPosition | null | undefined,
): boolean {
  const isFinitePosition = (
    position: StreamingCameraPosition | null | undefined,
  ): position is StreamingCameraPosition =>
    Boolean(
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y) &&
      Number.isFinite(position.z),
    );

  return Boolean(
    phase === "RESOLUTION" &&
    isFinitePosition(actorPosition) &&
    isFinitePosition(opponentPosition) &&
    isPositionInsideCombatArena(actorPosition.x, actorPosition.z) &&
    isPositionInsideCombatArena(opponentPosition.x, opponentPosition.z),
  );
}

/**
 * Resolve an immutable ring fallback for the narrow cleanup/state handoff. The
 * result shot normally follows live final positions; this pair is used only if
 * either transform is missing or has already left every combat arena.
 */
export function getStreamingResolutionArenaPair(
  phase: StreamingCinematicPhase | undefined,
  arenaPositions: StreamingArenaPositions | null | undefined,
  agent1Id: string | null | undefined,
  agent2Id: string | null | undefined,
  actorId: string | null | undefined,
): StreamingResolutionArenaPair | null {
  if (
    phase !== "RESOLUTION" ||
    !hasValidStreamingArenaPositions(arenaPositions) ||
    !actorId
  ) {
    return null;
  }
  if (actorId === agent1Id) {
    return {
      actor: arenaPositions.agent1,
      opponent: arenaPositions.agent2,
    };
  }
  if (actorId === agent2Id) {
    return {
      actor: arenaPositions.agent2,
      opponent: arenaPositions.agent1,
    };
  }
  return null;
}

export type StreamingCinematicPhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

export interface StreamingCinematicPhaseParams {
  radiusMin: number;
  radiusMax: number;
  basePhi: number;
  driftSpeed: number;
  targetFov: number;
  orbitAmplitude: number;
  focusBias: number;
}

export interface StreamingAspectFraming {
  radius: number;
  targetFov: number;
}

const STREAMING_REFERENCE_ASPECT = 16 / 9;
const STREAMING_UNCOMPENSATED_MIN_ASPECT = 4 / 3;
const STREAMING_MIN_SUPPORTED_ASPECT = 9 / 16;
const STREAMING_MAX_CINEMATIC_RADIUS = 16;

/**
 * Preserve canonical subject scale through 4:3, where the launch combat range
 * still fits the safe crop. Below 4:3, Three's vertical FOV needs progressively
 * stronger horizontal compensation. A squared response avoids making square
 * fighters unnecessarily tiny while retaining the proven 9:16 endpoint and
 * preventing ultra-narrow/invalid measurements from moving without bounds.
 */
export function getStreamingAspectFraming(
  baseRadius: number,
  baseFov: number,
  aspect: number | null | undefined,
  maxRadius = STREAMING_MAX_CINEMATIC_RADIUS,
): StreamingAspectFraming {
  const resolvedAspect =
    typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
      ? clamp(
          aspect,
          STREAMING_MIN_SUPPORTED_ASPECT,
          STREAMING_REFERENCE_ASPECT,
        )
      : STREAMING_REFERENCE_ASPECT;
  const narrowness = clamp(
    (STREAMING_UNCOMPENSATED_MIN_ASPECT - resolvedAspect) /
      (STREAMING_UNCOMPENSATED_MIN_ASPECT - STREAMING_MIN_SUPPORTED_ASPECT),
    0,
    1,
  );
  const compensation = narrowness * narrowness;

  return {
    radius: clamp(
      baseRadius * (1 + compensation * 0.75),
      baseRadius,
      maxRadius,
    ),
    targetFov: clamp(baseFov + compensation * 11, baseFov, 62),
  };
}

/**
 * Guarantee enough horizontal room for the live contestant pair without
 * changing the canonical close-combat shot. Arena staging and legal kiting can
 * briefly exceed the normal fighting radius; deriving the exceptional pullback
 * from perspective projection keeps those moments inside a conservative safe
 * crop on every supported aspect ratio.
 */
export function getStreamingSeparationAwareRadius(
  baseRadius: number,
  separation: number,
  verticalFovDegrees: number,
  aspect: number | null | undefined,
  maxRadius = STREAMING_MAX_CINEMATIC_RADIUS,
  safeHorizontalNdc = 0.6,
): number {
  const resolvedBaseRadius =
    Number.isFinite(baseRadius) && baseRadius > 0 ? baseRadius : 0;
  const resolvedSeparation =
    Number.isFinite(separation) && separation > 0 ? separation : 0;
  const resolvedAspect =
    typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
      ? clamp(
          aspect,
          STREAMING_MIN_SUPPORTED_ASPECT,
          STREAMING_REFERENCE_ASPECT,
        )
      : STREAMING_REFERENCE_ASPECT;
  const resolvedFov =
    Number.isFinite(verticalFovDegrees) && verticalFovDegrees > 0
      ? clamp(verticalFovDegrees, 1, 179)
      : 50;
  const resolvedSafeNdc =
    Number.isFinite(safeHorizontalNdc) && safeHorizontalNdc > 0
      ? clamp(safeHorizontalNdc, 0.1, 0.95)
      : 0.6;
  const resolvedMaxRadius =
    Number.isFinite(maxRadius) && maxRadius >= resolvedBaseRadius
      ? maxRadius
      : resolvedBaseRadius;
  const halfHorizontalSpanAtUnitRadius =
    Math.tan((resolvedFov * Math.PI) / 360) * resolvedAspect;
  const requiredRadius =
    resolvedSeparation / (2 * halfHorizontalSpanAtUnitRadius * resolvedSafeNdc);

  return clamp(
    Math.max(resolvedBaseRadius, requiredRadius),
    resolvedBaseRadius,
    resolvedMaxRadius,
  );
}

/**
 * Keep a nearby preparation pair meaningfully separated on screen without
 * over-tightening every open-world shot. Terrain-height compensation can
 * legitimately select the wider preparation envelope even when both full
 * bodies have ample HUD clearance; for a close horizontal pair that wider
 * radius can make two otherwise readable contestants merge into one visual
 * stack. Derive an upper radius from perspective projection and retain the
 * measured 4.25-unit body-size floor, which keeps the largest observed launch
 * avatar below the existing 0.75 NDC body-span ceiling.
 */
export function getStreamingPreparationSeparationRadius(
  baseRadius: number,
  horizontalSeparation: number,
  verticalFovDegrees: number,
  aspect: number | null | undefined,
  minimumRadius = 4.25,
  targetHorizontalNdcSeparation = 0.26,
): number {
  if (!Number.isFinite(baseRadius) || baseRadius <= 0) return 0;
  if (!Number.isFinite(horizontalSeparation) || horizontalSeparation <= 0) {
    return baseRadius;
  }

  const resolvedAspect =
    typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
      ? clamp(
          aspect,
          STREAMING_MIN_SUPPORTED_ASPECT,
          STREAMING_REFERENCE_ASPECT,
        )
      : STREAMING_REFERENCE_ASPECT;
  const resolvedFov =
    Number.isFinite(verticalFovDegrees) && verticalFovDegrees > 0
      ? clamp(verticalFovDegrees, 1, 179)
      : 50;
  const resolvedMinimumRadius =
    Number.isFinite(minimumRadius) && minimumRadius > 0
      ? Math.min(minimumRadius, baseRadius)
      : Math.min(4.25, baseRadius);
  const resolvedTargetSeparation =
    Number.isFinite(targetHorizontalNdcSeparation) &&
    targetHorizontalNdcSeparation > 0
      ? clamp(targetHorizontalNdcSeparation, 0.1, 0.95)
      : 0.26;
  const horizontalSpanAtUnitRadius =
    Math.tan((resolvedFov * Math.PI) / 360) * resolvedAspect;
  const maximumRadiusForTargetSeparation =
    horizontalSeparation /
    (horizontalSpanAtUnitRadius * resolvedTargetSeparation);

  return clamp(
    Math.min(baseRadius, maximumRadiusForTargetSeparation),
    resolvedMinimumRadius,
    baseRadius,
  );
}

/**
 * Project contestant spacing onto the ground plane before applying any
 * horizontal camera-fit policy. Open-world preparation can place two valid
 * staging tiles on meaningfully different terrain heights; including that Y
 * delta in a horizontal-fit decision can falsely reject an otherwise readable
 * side-by-side shot and fall back to a depth-stacked single-subject camera.
 * Vertical terrain compensation remains a separate, explicit lens concern.
 */
export function getStreamingHorizontalSeparation(
  first: Pick<StreamingCameraPosition, "x" | "z">,
  second: Pick<StreamingCameraPosition, "x" | "z">,
): number {
  const deltaX = first.x - second.x;
  const deltaZ = first.z - second.z;
  return Number.isFinite(deltaX) && Number.isFinite(deltaZ)
    ? Math.hypot(deltaX, deltaZ)
    : 0;
}

/**
 * Keep a second preparation subject only while the established cinematic
 * envelope can place both silhouettes inside the same horizontal safe crop.
 * Open-world preparation can separate contestants farther than the arena
 * camera's maximum pullback; in that case the director-selected actor must
 * remain readable instead of accepting a mathematically impossible wide shot.
 */
export function shouldFrameStreamingPreparationOpponent(
  separation: number,
  verticalFovDegrees: number,
  aspect: number | null | undefined,
  maxRadius = STREAMING_MAX_CINEMATIC_RADIUS,
  safeHorizontalNdc = 0.6,
): boolean {
  if (!Number.isFinite(separation) || separation <= 0) return false;
  const resolvedAspect =
    typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
      ? clamp(
          aspect,
          STREAMING_MIN_SUPPORTED_ASPECT,
          STREAMING_REFERENCE_ASPECT,
        )
      : STREAMING_REFERENCE_ASPECT;
  const resolvedFov =
    Number.isFinite(verticalFovDegrees) && verticalFovDegrees > 0
      ? clamp(verticalFovDegrees, 1, 179)
      : 50;
  const resolvedMaxRadius =
    Number.isFinite(maxRadius) && maxRadius > 0
      ? maxRadius
      : STREAMING_MAX_CINEMATIC_RADIUS;
  const resolvedSafeNdc =
    Number.isFinite(safeHorizontalNdc) && safeHorizontalNdc > 0
      ? clamp(safeHorizontalNdc, 0.1, 0.95)
      : 0.6;
  const halfHorizontalSpanAtUnitRadius =
    Math.tan((resolvedFov * Math.PI) / 360) * resolvedAspect;
  const requiredRadius =
    separation / (2 * halfHorizontalSpanAtUnitRadius * resolvedSafeNdc);
  return requiredRadius <= resolvedMaxRadius;
}

/**
 * Expand framing immediately when contestants separate, then release the extra
 * room gradually when they close. This keeps a legal kite/orbit step from
 * leaving the crop while avoiding the repeated push-in/pull-out that a raw
 * tile-by-tile separation signal would produce.
 */
export function getStreamingAdaptiveFramingSeparation(
  previous: number | null,
  current: number,
  deltaSeconds: number,
): number {
  const next = Number.isFinite(current) ? Math.max(0, current) : 0;
  if (previous === null || !Number.isFinite(previous) || next >= previous) {
    return next;
  }

  const releaseAlpha = 1 - Math.exp(-0.9 * Math.max(0, deltaSeconds));
  return previous + (next - previous) * releaseAlpha;
}

/**
 * Pull back faster than the camera pushes in. Expansion remains visibly
 * damped, but reaches a newly required two-subject radius before the next
 * server movement interval can compound the crop.
 */
export function dampStreamingCinematicRadius(
  current: number,
  target: number,
  deltaSeconds: number,
  transitionMultiplier = 1,
): number {
  const rate = target > current ? 18 : 3.5;
  const alpha = clamp(
    1 -
      Math.exp(
        -rate * Math.max(0, transitionMultiplier) * Math.max(0, deltaSeconds),
      ),
    0,
    1,
  );
  return current + (target - current) * alpha;
}

/** Follow active combat midpoints fast enough to survive coordinated wall arcs. */
export function getStreamingCinematicPositionDampingRate(
  phase: StreamingCinematicPhase,
): number {
  return phase === "FIGHTING" ? 36 : 5;
}

/** Keep a moving pair side-on before perspective makes one fighter unreadable. */
export function getStreamingCinematicFacingTurnRate(
  phase: StreamingCinematicPhase,
): number {
  return phase === "FIGHTING" ? 6 : 1.9;
}

/**
 * Resolve a wrapped cinematic angle without ever letting a preparation pair
 * drift away from its projection-safe side-on axis. A preparation camera is
 * established before publication, so retaining an older solo/pair heading in
 * either smoothing cache can put one contestant behind the other even though
 * the LOS candidate itself is locked.
 */
export function resolveStreamingCinematicTheta(
  currentTheta: number,
  targetTheta: number,
  maximumSpeedRadPerSecond: number,
  deltaSeconds: number,
  lockToTarget = false,
): number {
  if (lockToTarget) return targetTheta;

  const delta = Math.atan2(
    Math.sin(targetTheta - currentTheta),
    Math.cos(targetTheta - currentTheta),
  );
  const maximumStep = Math.max(
    0,
    maximumSpeedRadPerSecond * Math.max(0, deltaSeconds),
  );
  return currentTheta + clamp(delta, -maximumStep, maximumStep);
}

/** Track the authored combat angle promptly while retaining weighted interludes. */
export function getStreamingCinematicAngleDampingRate(
  phase: StreamingCinematicPhase,
  preparationPairShot = false,
): number {
  // The preparation LOS solver locks the camera to the live pair axis, but
  // the final spherical smoother is a separate layer. Letting that last layer
  // retain the ordinary IDLE rate makes it trail two nearby moving agents,
  // reintroducing a depth-stacked composition after the projection-safe
  // side-on angle has already been selected. Match the proven combat response
  // for a live preparation pair while retaining authored weight for solo and
  // non-combat presentation shots.
  return phase === "FIGHTING" || preparationPairShot ? 12 : 3.5;
}

/**
 * Apply the final spherical theta damping while bounding how far a live
 * preparation pair may trail its already-selected side-on axis. Ordinary
 * exponential damping remains active inside the residual envelope; outside
 * it, the camera catches up only far enough to preserve a readable two-shot.
 */
export function dampStreamingCinematicTheta(
  currentTheta: number,
  targetTheta: number,
  ratePerSecond: number,
  deltaSeconds: number,
  maximumResidualRadians = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isFinite(targetTheta)) {
    return Number.isFinite(currentTheta) ? currentTheta : 0;
  }
  if (!Number.isFinite(currentTheta)) return targetTheta;

  const delta = Math.atan2(
    Math.sin(targetTheta - currentTheta),
    Math.cos(targetTheta - currentTheta),
  );
  const resolvedRate =
    Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? ratePerSecond : 0;
  const resolvedDeltaSeconds =
    Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
  const alpha = clamp(1 - Math.exp(-resolvedRate * resolvedDeltaSeconds), 0, 1);
  let nextTheta = currentTheta + delta * alpha;

  if (Number.isFinite(maximumResidualRadians) && maximumResidualRadians >= 0) {
    const residual = Math.atan2(
      Math.sin(targetTheta - nextTheta),
      Math.cos(targetTheta - nextTheta),
    );
    const boundedResidual = clamp(
      residual,
      -maximumResidualRadians,
      maximumResidualRadians,
    );
    nextTheta = targetTheta - boundedResidual;
  }

  return nextTheta;
}

/**
 * Duel phases retain the established full separation response so legal kiting
 * remains framed. Preparation uses a tighter open-world two-subject shot.
 */
export function getStreamingCinematicSeparationRadiusScale(
  _phase: StreamingCinematicPhase,
  preparationShot = false,
): number {
  if (preparationShot) return 0.2;
  return 1.1;
}

/**
 * Keep live combat side-on so both contestants share the same perspective
 * scale and vertical margins. Non-combat phases retain a small authored
 * three-quarter angle for presentation variety.
 */
export function getStreamingCinematicSideAngle(
  phase: StreamingCinematicPhase,
): number {
  return phase === "FIGHTING" ? Math.PI * 0.5 : Math.PI * 0.56;
}

/**
 * Derive a stable pair direction from the authoritative contestant ordering.
 * The broadcast director may switch its tracked actor during a fight, but that
 * must not reverse the pair vector and ask the camera to orbit 180 degrees.
 */
export function getStreamingCanonicalPairFacingTheta(
  actorPosition: Pick<THREE.Vector3, "x" | "z">,
  opponentPosition: Pick<THREE.Vector3, "x" | "z">,
  actorId: string | null,
  agent1Id: string | null | undefined,
  agent2Id: string | null | undefined,
): number {
  const actorIsAuthoritativeAgent2 =
    Boolean(actorId) &&
    Boolean(agent1Id) &&
    Boolean(agent2Id) &&
    actorId === agent2Id;
  const deltaX = actorIsAuthoritativeAgent2
    ? actorPosition.x - opponentPosition.x
    : opponentPosition.x - actorPosition.x;
  const deltaZ = actorIsAuthoritativeAgent2
    ? actorPosition.z - opponentPosition.z
    : opponentPosition.z - actorPosition.z;
  return Math.atan2(deltaX, deltaZ);
}

/**
 * A live two-contestant fight must remain centered on the pair. Leading only
 * the camera target makes one legal kite step push the opposite silhouette
 * into the HUD crop. Presentation and preparation shots can retain authored
 * anticipation because they do not have the same symmetric combat envelope.
 */
export function getStreamingCinematicLeadScale(
  phase: StreamingCinematicPhase,
  preparationPairShot = false,
): number {
  // A two-subject preparation lens is composed around the pair midpoint. A
  // velocity lead shifts the camera's spherical origin while lookAt remains on
  // that midpoint, rotating the real view away from the side-on axis and
  // allowing the silhouettes to overlap despite a correct theta.
  if (preparationPairShot) return 0;
  if (phase === "FIGHTING") return 0;
  return phase === "IDLE" ? 1.5 : 0.8;
}

/**
 * Resolve the authored lens plus transient combat feedback. A hit punch-in
 * must narrow the lens; increasing vertical FOV would visually pull the
 * contestants away at the exact moment the impact should read more clearly.
 */
export function getStreamingCinematicTargetFov(
  phase: StreamingCinematicPhase,
  baseFov: number,
  punchIn: number,
): number {
  const resolvedBaseFov = Number.isFinite(baseFov)
    ? clamp(baseFov, 40, 62)
    : 48;
  if (phase !== "FIGHTING") return resolvedBaseFov;

  const resolvedPunchIn = Number.isFinite(punchIn) ? clamp(punchIn, 0, 1) : 0;
  return clamp(resolvedBaseFov - resolvedPunchIn * 1.5, 40, 62);
}

/** Broadcast-safe framing bounds for each authoritative duel phase. */
export function getStreamingCinematicPhaseParams(
  phase: StreamingCinematicPhase,
): StreamingCinematicPhaseParams {
  switch (phase) {
    case "ANNOUNCEMENT":
      return {
        // Keep the staged shot inside the active ring. Wider orbits can place
        // the camera behind neighbouring arena geometry even when both
        // contestants themselves remain technically visible.
        radiusMin: 7,
        radiusMax: 8.25,
        basePhi: Math.PI * 0.3,
        driftSpeed: 0.02,
        targetFov: 48,
        orbitAmplitude: 0.08,
        focusBias: 0.35,
      };
    case "COUNTDOWN":
      return {
        radiusMin: 7,
        radiusMax: 9,
        basePhi: Math.PI * 0.34,
        driftSpeed: 0,
        targetFov: 48,
        orbitAmplitude: 0.02,
        focusBias: 0.5,
      };
    case "FIGHTING":
      return {
        radiusMin: 5.5,
        // Keep ordinary five-metre exchanges large enough to read on stream.
        // Wider kite diagonals still pull back independently through the
        // projection-derived separation envelope below, so this close-combat
        // cap does not trade away the 0.72 HUD-safe boundary.
        radiusMax: 7.2,
        basePhi: Math.PI * 0.3,
        driftSpeed: 0.018,
        // The compressed silhouette in ranged attack/run poses remains
        // readable with margin while the widest observed duel still stays
        // comfortably inside the 0.72 horizontal HUD-safe boundary.
        targetFov: 46,
        orbitAmplitude: 0.055,
        focusBias: 0.5,
      };
    case "RESOLUTION":
      return {
        // The result overlay already supplies the wide presentation layer;
        // keep the 3D cutaway inside the same proven clear envelope as the
        // countdown instead of exposing adjacent arena floors.
        radiusMin: 6.75,
        radiusMax: 8.25,
        basePhi: Math.PI * 0.4,
        driftSpeed: 0.02,
        targetFov: 48,
        orbitAmplitude: 0.045,
        focusBias: 0.5,
      };
    default:
      return {
        // Anonymous inter-cycle coverage should read as a clean empty ring,
        // not a map-wide establishing shot through neighbouring structures.
        radiusMin: 8,
        radiusMax: 9,
        basePhi: Math.PI * 0.28,
        driftSpeed: 0.015,
        targetFov: 52,
        orbitAmplitude: 0.08,
        focusBias: 0.5,
      };
  }
}

/**
 * Aim live combat at the contestants' torso center. The lower target keeps the
 * full-body pair vertically balanced under the broadcast HUD at close radius.
 */
export function getStreamingCinematicLookAtHeight(
  phase: StreamingCinematicPhase,
  preparationShot = false,
  preparationVerticalSeparation = 0,
): number {
  // The preparation HUD reserves more space below than an arena fight. Aim at
  // the avatars' body midpoint, then lower the aim point boundedly as uneven
  // terrain moves one contestant toward the lower status card. A retained
  // full-3D HLS frame with 0.75m+ vertical separation still put the lower
  // contestant's feet behind that card at the ordinary 0.96m aim point. The
  // 0.24m correction moves the complete pair into the established broadcast
  // corridor while preserving the level-ground composition unchanged. The
  // first 0.14m correction cleared the initial crop, but activating the true
  // side-on pair lens exposed the lower root a few pixels inside the -0.68 NDC
  // status-card boundary at a measured 5.252975m radius. The additional 0.10m
  // produces roughly 0.052 NDC of clearance at the authored 40-degree lens;
  // the retained upper silhouette had substantially more than that margin to
  // the +0.48 identity-panel boundary.
  if (preparationShot) {
    const resolvedVerticalSeparation =
      Number.isFinite(preparationVerticalSeparation) &&
      preparationVerticalSeparation > 0
        ? preparationVerticalSeparation
        : 0;
    const unevenTerrainBlend = clamp(
      (resolvedVerticalSeparation - 0.25) / 0.5,
      0,
      1,
    );
    return 0.96 - unevenTerrainBlend * 0.24;
  }
  return phase === "FIGHTING" ? 1.02 : 1.12;
}

/**
 * Preparation happens in the open world, but it is still a deliberate
 * two-subject broadcast shot. Keep both contestants comfortably inside the
 * 16:9 safe crop without using the much wider anonymous IDLE arena framing.
 */
export function getStreamingPreparationCinematicParams(): StreamingCinematicPhaseParams {
  return {
    // The preparation HUD leaves a deliberate center stage between its top
    // identity panel and lower status card. The first close-envelope live pass
    // reached 0.799879 NDC at radius 3.877 and a later orbit cropped both
    // contestants at radius 3.523. The open-world preparation pair can also
    // stand at different terrain heights; the 4.5-4.75 envelope left one
    // otherwise complete body on a HUD boundary in repeated real captures.
    // This slightly wider envelope projects the measured bodies to roughly
    // 0.56-0.60 NDC: still readable, with real head/foot clearance for both.
    radiusMin: 5.15,
    radiusMax: 5.3,
    basePhi: Math.PI * 0.4,
    driftSpeed: 0.012,
    targetFov: 40,
    orbitAmplitude: 0.035,
    focusBias: 0.5,
  };
}

/**
 * Bring a nearly level preparation pair close enough to read side by side,
 * while retaining the wider proven envelope when open-world terrain places
 * their feet at meaningfully different heights. The transition is derived
 * only from the two authoritative positions and does not introduce a product
 * timing or director decision.
 */
export function getStreamingPreparationPairRadiusBounds(
  verticalSeparation: number,
): { radiusMin: number; radiusMax: number } {
  if (!Number.isFinite(verticalSeparation) || verticalSeparation < 0) {
    return { radiusMin: 5.15, radiusMax: 5.3 };
  }
  const terrainBlend = clamp((verticalSeparation - 0.25) / 0.5, 0, 1);
  return {
    radiusMin: 4.55 + terrainBlend * 0.6,
    radiusMax: 4.6 + terrainBlend * 0.7,
  };
}

/**
 * Put the preparation camera on the contestants' land-side of the interaction
 * target. For shoreline activities this looks through the actors toward the
 * authored water/resource context instead of pointing away from it.
 */
export function getStreamingPreparationCameraTheta(
  subjectFocus: Pick<StreamingPreparationPosition, "x" | "z">,
  activityTarget: Pick<StreamingPreparationPosition, "x" | "z"> | null,
  fallbackTheta: number,
): number {
  if (!activityTarget) return fallbackTheta;
  const awayX = subjectFocus.x - activityTarget.x;
  const awayZ = subjectFocus.z - activityTarget.z;
  if (awayX * awayX + awayZ * awayZ < 0.0625) return fallbackTheta;
  return Math.atan2(awayX, awayZ) + Math.PI * 0.05;
}

/**
 * Keep a two-subject preparation shot close to side-on while still revealing
 * the selected actor's authoritative activity context. An unconstrained
 * target-facing angle can put one contestant much nearer the lens, turning a
 * valid pair shot into a cropped foreground body plus a small background body.
 * Solo preparation shots retain the full contextual angle above.
 */
export function getStreamingPreparationPairCameraTheta(
  subjectFocus: Pick<StreamingPreparationPosition, "x" | "z">,
  activityTarget: Pick<StreamingPreparationPosition, "x" | "z"> | null,
  sideOnTheta: number,
  maximumContextOffset = Math.PI / 18,
): number {
  const contextualTheta = getStreamingPreparationCameraTheta(
    subjectFocus,
    activityTarget,
    sideOnTheta,
  );
  const resolvedMaximumOffset =
    Number.isFinite(maximumContextOffset) && maximumContextOffset >= 0
      ? clamp(maximumContextOffset, 0, Math.PI)
      : Math.PI / 18;
  const shortestDelta = Math.atan2(
    Math.sin(contextualTheta - sideOnTheta),
    Math.cos(contextualTheta - sideOnTheta),
  );
  return (
    sideOnTheta +
    clamp(shortestDelta, -resolvedMaximumOffset, resolvedMaximumOffset)
  );
}

/**
 * A contestant outside the bounded two-subject envelope must not be allowed to
 * linger as a cropped body at the edge of the selected actor's solo shot. Put
 * the camera between the two contestants so the excluded body remains behind
 * the lens, then admit only a small activity-context offset. The ordinary
 * contextual angle remains the fallback when no second contestant exists.
 */
export function getStreamingPreparationSoloCameraTheta(
  subjectFocus: Pick<StreamingPreparationPosition, "x" | "z">,
  excludedContestant: Pick<StreamingPreparationPosition, "x" | "z"> | null,
  activityTarget: Pick<StreamingPreparationPosition, "x" | "z"> | null,
  fallbackTheta: number,
  maximumContextOffset = Math.PI / 18,
): number {
  if (!excludedContestant) {
    return getStreamingPreparationCameraTheta(
      subjectFocus,
      activityTarget,
      fallbackTheta,
    );
  }
  const towardExcludedX = excludedContestant.x - subjectFocus.x;
  const towardExcludedZ = excludedContestant.z - subjectFocus.z;
  if (
    !Number.isFinite(towardExcludedX) ||
    !Number.isFinite(towardExcludedZ) ||
    towardExcludedX * towardExcludedX + towardExcludedZ * towardExcludedZ <
      0.0625
  ) {
    return getStreamingPreparationCameraTheta(
      subjectFocus,
      activityTarget,
      fallbackTheta,
    );
  }
  const isolationTheta = Math.atan2(towardExcludedX, towardExcludedZ);
  return getStreamingPreparationPairCameraTheta(
    subjectFocus,
    activityTarget,
    isolationTheta,
    maximumContextOffset,
  );
}

/**
 * Compose the public two-contestant preparation hold from the canonical pair
 * axis, not the general IDLE orbit. The ordinary IDLE three-quarter angle,
 * drift, and contextual offset can combine into enough depth perspective for
 * one full body to enter the top HUD while the other approaches the lower HUD.
 * Five degrees preserves a hint of activity context without compromising the
 * equal-scale side-by-side read.
 */
export function getStreamingPreparationPairSideOnTheta(
  pairFacingTheta: number,
  subjectFocus: Pick<StreamingPreparationPosition, "x" | "z">,
  activityTarget: Pick<StreamingPreparationPosition, "x" | "z"> | null,
): number {
  return getStreamingPreparationPairCameraTheta(
    subjectFocus,
    activityTarget,
    pairFacingTheta + Math.PI * 0.5,
    Math.PI / 36,
  );
}

const STANDARD_STREAMING_LOS_THETA_OFFSETS = [
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
] as const;
const LOCKED_STREAMING_LOS_THETA_OFFSETS = [0] as const;

/**
 * Preparation pairs must remain on their already-bounded side-on axis. Other
 * open-world presentation shots search the complete orbit: a shoreline or
 * hillside can obstruct every candidate within 60 degrees of the contextual
 * angle, and accepting that partial search can place the camera inside terrain
 * while projected avatar coordinates still look valid.
 */
export function getStreamingCinematicLosThetaOffsets(
  preparationPairShot: boolean,
): readonly number[] {
  return preparationPairShot
    ? LOCKED_STREAMING_LOS_THETA_OFFSETS
    : STANDARD_STREAMING_LOS_THETA_OFFSETS;
}

const _v3_1 = new THREE.Vector3();
const _v3_2 = new THREE.Vector3();
const _v3_3 = new THREE.Vector3();
const _q_1 = new THREE.Quaternion();
const _sph_1 = new THREE.Spherical();
const _cinematicActorPos = new THREE.Vector3();
const _cinematicOpponentPos = new THREE.Vector3();
const _cinematicFocusPos = new THREE.Vector3();
const _cinematicLookAtPos = new THREE.Vector3();
const _cinematicProbePos = new THREE.Vector3();
const _cinematicProbeTarget = new THREE.Vector3();
const _cinematicProbeDir = new THREE.Vector3();
const _cinematicBestOffset = new THREE.Vector3();
const _cinematicTransitionDir = new THREE.Vector3();
const _cinematicOrientationMatrix = new THREE.Matrix4();
const _cinematicOrientationQuat = new THREE.Quaternion();
const _cinematicOrientationUp = new THREE.Vector3(0, 1, 0);
const _cinematicShakeOffset = new THREE.Vector3();
const _cinematicLeadOffset = new THREE.Vector3();
// Pre-allocated arrays for getCameraInfo to avoid allocations
const _cameraInfoOffset: number[] = [0, 0, 0];
const _cameraInfoPosition: number[] = [0, 0, 0];

export class ClientCameraSystem extends SystemBase {
  private camera: THREE.PerspectiveCamera | null = null;
  private target: CameraTarget | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raycastService: RaycastService | null = null;
  private initRetryCount = 0;
  private static readonly MAX_INIT_RETRIES = 30; // 3 seconds max wait

  // Camera state for different modes
  private spherical = new THREE.Spherical(6, Math.PI * 0.42, Math.PI); // current radius, phi, theta
  private targetSpherical = new THREE.Spherical(6, Math.PI * 0.42, Math.PI); // target spherical for smoothing
  private targetPosition = new THREE.Vector3();
  private smoothedTarget = new THREE.Vector3();
  private cameraPosition = new THREE.Vector3();
  private cameraOffset = new THREE.Vector3(0, 1.3, 0);
  private lookAtTarget = new THREE.Vector3();
  // Collision-aware effective radius
  private effectiveRadius = 6;
  // Zoom handling flags to make zoom move instantly with no easing
  private zoomDirty = false;
  private lastDesiredRadius = this.spherical.radius;

  // Control settings
  private readonly settings = {
    // modern MMORPG-like zoom bounds (further min to avoid getting too close)
    minDistance: 2.0,
    maxDistance: 15.0,
    // Passive broadcast framing may back out farther than an interactive player
    // camera so legal full-ring spacing stays inside supported portrait crops.
    maxCinematicDistance: STREAMING_MAX_CINEMATIC_RADIUS,
    // Pitch limits: allow higher arc for more overhead viewing
    minPolarAngle: Math.PI * 0.15,
    maxPolarAngle: Math.PI * 0.48,
    // modern MMORPG-like feel
    rotateSpeed: 0.9,
    zoomSpeed: 1.2,
    panSpeed: 2.0,
    // Separate damping for crisp zoom vs smooth rotation
    rotationDampingFactor: 0.12,
    zoomDampingFactor: 0.22,
    // Damping for radius changes to avoid snap on MMB press
    radiusDampingFactor: 0.18,
    cameraLerpFactor: 0.1,
    invertY: false,
    // Discrete zoom step per wheel notch (world units)
    zoomStep: 0.6,
    // Over-the-shoulder offset: character moves to left when zoomed in (like Fortnite)
    shoulderOffsetMax: 0.15, // Max horizontal offset when fully zoomed in
    shoulderOffsetSide: -1, // -1 = left, 1 = right
  };

  // Cinematic spectator controls for duel streaming
  private streamPageMode = false;
  private cinematicEnabled = false;
  /** Dashboard viewport locked to a specific agent — streaming retarget is suppressed. */
  private dashboardFollowMode = false;
  private cinematicClock = Math.random() * 1000;
  private latestStreamingState: StreamingCameraStateUpdate | null = null;
  private lastStreamingStateAt = 0;
  private cinematicLosMask: number | null = null;
  private cinematicCollisionMask: number | null = null;
  private cinematicThetaCache = this.spherical.theta;
  private cinematicThetaCacheValid = false;
  private cinematicPhiCache = this.spherical.phi;
  private cinematicPhiCacheValid = false;
  private cinematicLastLosRefreshAt = 0;
  private cinematicLastBaseTheta = 0;
  private cinematicLastHasOpponent = false;
  private cinematicFacingTheta = this.spherical.theta;
  private cinematicFacingThetaValid = false;
  private cinematicLastActorSample = new THREE.Vector3();
  private cinematicLastOpponentSample = new THREE.Vector3();
  // Combat-reactive camera state
  private cinematicPunchIn = 0;
  private cinematicDramaticLow = 0;
  private cinematicLastActorHP: number | null = null;
  private cinematicLastOpponentHP: number | null = null;
  // Last known good target position (fallback when entity position unavailable)
  private lastKnownTargetPosition = new THREE.Vector3();
  private hasLastKnownPosition = false;
  /** Stable virtual target used between duel cycles after agents leave the ring. */
  private readonly streamingArenaTarget: CameraTarget = {
    position: new THREE.Vector3(),
    data: { id: "streaming-arena-anchor" },
  };
  private hasStreamingArenaFocus = false;
  // Cached terrain system reference
  private terrainSystemRef: TerrainSystem | null | undefined = undefined;
  // Phase-aware camera state
  private cinematicPhase: StreamingCinematicPhase = "IDLE";
  private cinematicPhaseChangedAt = 0;
  /** Live replicated preparation authority for the current render frame. */
  private streamingPreparationActive = false;
  private streamingPreparationFocus: StreamingPreparationFocus | null = null;
  private streamingPreparationPairShotActive = false;
  // Smart camera cuts
  private cinematicHardCutPending = false;
  private cinematicFastSnapRemaining = 0;
  // Camera shake
  private cinematicShakeIntensity = 0;
  private cinematicShakeTime = 0;
  // Dynamic FOV
  private cinematicTargetFov = 55;
  // Movement lead (velocity tracking)
  private cinematicPrevActorPos = new THREE.Vector3();
  private cinematicHasPrevActorPos = false;
  private cinematicVelocity = new THREE.Vector3();
  // Smoothed entity Y to filter out frame-to-frame jitter from interpolation/terrain
  private cinematicSmoothedActorY = 0;
  private cinematicSmoothedOpponentY = 0;
  private cinematicHasSmoothedY = false;
  // Locked Y positions during duel combat — entities are in a flat arena so Y should be constant.
  // Without this lock, TileInterpolator terrain sampling, InterpolationEngine snapshots,
  // and ClientNetwork direct writes all compete for entity.position.y, causing frame-to-frame noise.
  private cinematicLockedActorY: number | null = null;
  private cinematicLockedOpponentY: number | null = null;
  // Locked composition separation keeps the authored pitch stable while agents
  // reposition. Framing separation expands immediately and releases slowly so
  // legal ranged movement cannot outgrow the camera radius.
  private cinematicLockedSeparation: number | null = null;
  private cinematicFramingSeparation: number | null = null;
  // Smoothed phase bias to prevent instant Y jumps when duel phase changes
  private cinematicSmoothedBias = 0.5;
  private cinematicSmoothedBiasValid = false;
  /** Prior HP from streaming state — damage deltas drive punch/shake */
  private streamingPrevAgent1Hp: number | null = null;
  private streamingPrevAgent2Hp: number | null = null;
  private readonly cinematicTuning = {
    thetaRefreshRate: 0.8,
    thetaIdleDriftRate: 0.25,
    thetaTargetRate: 0.85,
    thetaAppliedRate: 0.8,
    phiTargetRate: 0.35,
    phiAppliedRate: 0.3,
    maxDriftStep: 0.012,
    flipPenaltyStartRad: 1.45,
    focusBaseSpeed: 8.5,
    focusDistanceSpeedGain: 0.75,
    focusMaxSpeed: 180,
    lookBaseSpeed: 9,
    lookDistanceSpeedGain: 0.85,
    lookMaxSpeed: 220,
  } as const;

  // Mouse state
  private mouseState = {
    rightDown: false,
    middleDown: false,
    leftDown: false,
    lastPosition: new THREE.Vector2(),
    delta: new THREE.Vector2(),
  };
  // Touch state for mobile
  private touchState = {
    active: false,
    touchId: -1,
    startPosition: new THREE.Vector2(),
    lastPosition: new THREE.Vector2(),
  };
  // Two-finger touch state for pinch zoom
  private pinchState = {
    active: false,
    initialDistance: 0,
    lastDistance: 0,
  };
  // Orbit state to prevent press-down snap until actual drag movement
  private orbitingActive = false;
  private orbitingPrimed = false;
  // Track left-click drag to suppress click events when dragging
  private leftDragStarted = false;
  private leftMouseStartPosition = new THREE.Vector2();

  // Bound event handlers for cleanup
  private boundHandlers = {
    mouseDown: this.onMouseDown.bind(this),
    mouseMove: this.onMouseMove.bind(this),
    mouseUp: this.onMouseUp.bind(this),
    mouseWheel: this.onMouseWheel.bind(this),
    mouseLeave: this.onMouseLeave.bind(this),
    contextMenu: this.onContextMenu.bind(this),
    click: this.onClickCapture.bind(this),
    keyDown: this.onKeyDown.bind(this),
    keyUp: this.onKeyUp.bind(this),
    touchStart: this.onTouchStart.bind(this),
    touchMove: this.onTouchMove.bind(this),
    touchEnd: this.onTouchEnd.bind(this),
  };

  constructor(world: World) {
    super(world, {
      name: "client-camera",
      dependencies: { required: [], optional: [] },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    if (!this.world.isClient) return;

    // Listen for camera events via event bus (typed)
    this.subscribe(
      EventType.CAMERA_SET_TARGET,
      (data: { target?: CameraTarget }) => {
        if (!data?.target) {
          return;
        }
        if (
          this.cinematicEnabled &&
          shouldHoldStreamingArenaCamera(
            this.latestStreamingState?.cycle?.phase,
            this.dashboardFollowMode,
            this.latestStreamingState?.cycle?.arenaPositions,
            this.hasActiveStreamingPreparation(),
            this.hasAuthoritativeStreamingIdleTarget(),
          )
        ) {
          this.setStreamingArenaTarget();
          return;
        }
        // Preserve full entity identity (id/characterId/data) so spectator
        // follow checks can verify the camera is locked on the expected target.
        this.onSetTarget({ target: data.target });
      },
    );
    this.subscribe(EventType.CAMERA_RESET, () => this.resetCamera());

    // Listen for player events
    this.subscribe(
      EventType.PLAYER_AVATAR_READY,
      (data: { playerId: string; avatar: unknown; camHeight: number }) =>
        this.onAvatarReady({
          playerId: data.playerId,
          // Handle null avatar (from instanced rendering) or extract base from avatar object
          avatar: data.avatar
            ? ((data.avatar as { base?: THREE.Object3D }).base ??
              ({} as THREE.Object3D))
            : ({} as THREE.Object3D),
          camHeight: data.camHeight,
        }),
    );
    this.subscribe(EventType.PLAYER_REGISTERED, () => {
      if (!this.target) {
        this.initializePlayerTarget();
      }
    });
    this.subscribe(EventType.PLAYER_READY, () => {
      if (!this.target) {
        this.initializePlayerTarget();
      }
    });

    const context = this.resolveCinematicContext();
    this.streamPageMode = context.streamPageMode;
    this.cinematicEnabled =
      context.streamPageMode || context.embeddedSpectatorMode;

    // Dashboard viewfinders have an explicit followEntity — they should use
    // cinematic camera style but NOT retarget to the streaming duel's
    // cameraTarget.  Detect via multiple signals since ClientNetwork may not
    // have connected yet when the camera system initializes:
    //   1. Frozen follow value from a prior ClientNetwork instance (HMR)
    //   2. URL params (always available at init time)
    //   3. __HYPERIA_CONFIG__ (set by the iframe host before load)
    if (this.cinematicEnabled && typeof window !== "undefined") {
      const frozenFollow =
        (window as { __HYPERIA_ORIGINAL_FOLLOW__?: string })
          .__HYPERIA_ORIGINAL_FOLLOW__ || null;
      let urlFollow: string | null = null;
      try {
        const params = new URLSearchParams(window.location.search);
        urlFollow =
          params.get("followEntity") || params.get("characterId") || null;
      } catch {
        /* ignore */
      }
      const configFollow =
        (
          window as {
            __HYPERIA_CONFIG__?: {
              followEntity?: string;
              characterId?: string;
            };
          }
        ).__HYPERIA_CONFIG__?.followEntity ||
        (window as { __HYPERIA_CONFIG__?: { characterId?: string } })
          .__HYPERIA_CONFIG__?.characterId ||
        null;
      if (frozenFollow || urlFollow || configFollow) {
        this.dashboardFollowMode = true;
      }
    }

    this.subscribe<StreamingCameraStateUpdate>(
      "streaming:state:update",
      (state) => {
        this.latestStreamingState = state;
        this.lastStreamingStateAt = Date.now();
        // Detect phase changes for camera style transitions
        const newPhase = state.cycle?.phase ?? "IDLE";
        if (newPhase !== this.cinematicPhase) {
          this.onCinematicPhaseChange(this.cinematicPhase, newPhase);
          this.cinematicPhase = newPhase;
          this.cinematicPhaseChangedAt = Date.now();
        }
        this.rememberStreamingArenaFocus(state);
        if (
          shouldHoldStreamingArenaCamera(
            newPhase,
            this.dashboardFollowMode,
            state.cycle?.arenaPositions,
            this.hasActiveStreamingPreparation(),
            this.hasAuthoritativeStreamingIdleTarget(state),
          )
        ) {
          this.setStreamingArenaTarget();
        } else if (newPhase === "IDLE") {
          if (!this.tryRetargetStreamingPreparation()) {
            this.tryRetargetFromStreamingState();
          }
        } else {
          this.tryRetargetFromStreamingState();
        }
        this.onStreamingStateHP(state);
      },
    );

    // Don't detect camera mode here - wait until systems are fully loaded
  }

  start(): void {
    if (!this.world.isClient) return;
    this.tryInitialize();
    this.detachCameraFromRig();
  }

  private detachCameraFromRig(): void {
    if (!this.camera || !this.world.stage?.scene) return;

    // Remove camera from rig if it's attached
    if (this.camera.parent === this.world.rig) {
      // Get world position and rotation before removing from parent
      const worldPos = _v3_1;
      const worldQuat = _q_1;
      this.camera.getWorldPosition(worldPos);
      this.camera.getWorldQuaternion(worldQuat);

      // Remove from rig
      if (this.world.rig) {
        this.world.rig.remove(this.camera);
      }

      // Add directly to scene
      this.world.stage.scene.add(this.camera);

      // Restore world transform
      this.camera.position.copy(worldPos);
      this.camera.quaternion.copy(worldQuat);
    } else if (
      this.camera.parent &&
      this.camera.parent !== this.world.stage.scene
    ) {
      console.warn(
        "[ClientCameraSystem] Camera has unexpected parent:",
        this.camera.parent,
      );
    }
  }

  private tryInitialize(): void {
    this.camera = this.world.camera;
    this.canvas = this.world.graphics?.renderer?.domElement ?? null;

    if (!this.camera || !this.canvas) {
      this.initRetryCount++;
      if (this.initRetryCount < ClientCameraSystem.MAX_INIT_RETRIES) {
        setTimeout(() => this.tryInitialize(), 100);
      } else {
        console.error(
          "[ClientCameraSystem] Failed to initialize: camera or canvas not available after max retries",
        );
      }
      return;
    }

    // Get shared RaycastService from InteractionRouter for cache sharing
    // Both systems benefit from the same 16ms frame-based cache
    const interaction = this.world.getSystem("interaction") as
      { getRaycastService?: () => RaycastService } | undefined;
    const sharedService = interaction?.getRaycastService?.();
    if (sharedService) {
      this.raycastService = sharedService;
    } else if (this.initRetryCount < ClientCameraSystem.MAX_INIT_RETRIES) {
      // InteractionRouter not ready yet (registerSystems is async)
      // Retry initialization in 100ms to get the shared service
      this.initRetryCount++;
      if (this.initRetryCount === 1) {
        // Only log once on first retry
        console.log("[ClientCameraSystem] Waiting for InteractionRouter...");
      }
      setTimeout(() => this.tryInitialize(), 100);
      return;
    } else {
      // Max retries reached - create our own RaycastService as fallback
      console.warn(
        "[ClientCameraSystem] InteractionRouter not available after max retries, creating standalone RaycastService",
      );
      this.raycastService = new RaycastService(this.world);
    }

    // Ensure camera is detached from rig once it's available
    this.detachCameraFromRig();

    // Initialize camera position to avoid starting at origin
    if (this.camera.position.lengthSq() < 0.01) {
      this.camera.position.set(0, 10, 10); // Start above and behind origin
    }

    this.setupEventListeners();

    // Try to follow local player now; update() retries if local player is not ready yet.
    this.initializePlayerTarget();
  }

  private initializePlayerTarget(): void {
    if (this.tryAcquireLocalPlayerTarget()) {
      this.initializeCameraPosition();
    } else {
      this.logger.info("No local player found yet, waiting for spawn");
    }
  }

  private tryAcquireLocalPlayerTarget(): boolean {
    const localPlayer = this.world.getPlayer();
    if (!localPlayer || !localPlayer.id) {
      return false;
    }

    this.logger.info(`Setting player as camera target: ${localPlayer.id}`);
    this.onSetTarget({ target: localPlayer as CameraTarget });
    this.emitTypedEvent(EventType.CAMERA_TARGET_CHANGED, {
      target: localPlayer as CameraTarget,
    });
    return true;
  }

  private setupEventListeners(): void {
    if (!this.canvas) return;

    // Use capture phase for mouse events so camera runs before other interaction systems
    this.canvas.addEventListener(
      "mousedown",
      this.boundHandlers.mouseDown as EventListener,
      true,
    );
    this.canvas.addEventListener(
      "mousemove",
      this.boundHandlers.mouseMove as EventListener,
      true,
    );
    this.canvas.addEventListener(
      "mouseup",
      this.boundHandlers.mouseUp as EventListener,
      true,
    );
    this.canvas.addEventListener(
      "wheel",
      this.boundHandlers.mouseWheel as EventListener,
      true,
    );
    this.canvas.addEventListener(
      "mouseleave",
      this.boundHandlers.mouseLeave as EventListener,
      true,
    );

    // Listen to contextmenu to mark when we're handling camera rotation
    // Use capture phase to run before InteractionSystem
    this.canvas.addEventListener(
      "contextmenu",
      this.boundHandlers.contextMenu as EventListener,
      true,
    );
    // Capture click events to suppress them when we've been dragging
    this.canvas.addEventListener(
      "click",
      this.boundHandlers.click as EventListener,
      true,
    );

    document.addEventListener(
      "keydown",
      this.boundHandlers.keyDown as EventListener,
    );
    document.addEventListener(
      "keyup",
      this.boundHandlers.keyUp as EventListener,
    );

    // Touch events for mobile camera control
    this.canvas.addEventListener(
      "touchstart",
      this.boundHandlers.touchStart as EventListener,
      { passive: false },
    );
    this.canvas.addEventListener(
      "touchmove",
      this.boundHandlers.touchMove as EventListener,
      { passive: false },
    );
    this.canvas.addEventListener(
      "touchend",
      this.boundHandlers.touchEnd as EventListener,
    );
    this.canvas.addEventListener(
      "touchcancel",
      this.boundHandlers.touchEnd as EventListener,
    );
  }

  private onMouseDown(event: MouseEvent): void {
    // Handle camera controls in capture phase before other systems

    if (event.button === 2) {
      // Right mouse button - context menu (optional, could disable)
      event.preventDefault(); // Prevent context menu
      event.stopPropagation(); // Stop event from reaching other systems
      this.mouseState.rightDown = true;
    } else if (event.button === 1) {
      // Middle mouse button for camera rotation
      event.preventDefault();
      event.stopPropagation(); // Stop event from reaching other systems
      this.mouseState.middleDown = true;

      // Align targets to current spherical to avoid any initial jump
      this.targetSpherical.theta = this.spherical.theta;
      this.targetSpherical.phi = this.spherical.phi;
      // Prime orbiting; activate only after passing small drag threshold
      this.orbitingPrimed = true;
      this.orbitingActive = false;

      this.canvas!.style.cursor = "grabbing";
    } else if (event.button === 0) {
      // Left mouse button - can rotate camera if dragged, or click-to-move if not
      this.mouseState.leftDown = true;
      this.leftDragStarted = false;
      this.leftMouseStartPosition.set(event.clientX, event.clientY);

      // Align targets to current spherical to avoid any initial jump (same as middle mouse)
      this.targetSpherical.theta = this.spherical.theta;
      this.targetSpherical.phi = this.spherical.phi;
      // Prime orbiting; activate only after passing small drag threshold
      this.orbitingPrimed = true;
      // Don't prevent default yet - let click propagate if no drag occurs
    }

    this.mouseState.lastPosition.set(event.clientX, event.clientY);
  }

  private onMouseMove(event: MouseEvent): void {
    // Handle middle mouse button OR left mouse button drag for camera rotation
    if (this.mouseState.middleDown || this.mouseState.leftDown) {
      this.mouseState.delta.set(
        event.clientX - this.mouseState.lastPosition.x,
        event.clientY - this.mouseState.lastPosition.y,
      );

      // For left mouse, check if we've exceeded drag threshold from start position
      if (this.mouseState.leftDown && !this.leftDragStarted) {
        const totalDrag = Math.hypot(
          event.clientX - this.leftMouseStartPosition.x,
          event.clientY - this.leftMouseStartPosition.y,
        );
        if (totalDrag > 5) {
          // 5px threshold before we consider it a drag
          this.leftDragStarted = true;
          this.orbitingActive = true;
          this.orbitingPrimed = false;
          this.canvas!.style.cursor = "grabbing";
        }
      }

      // For middle mouse, activate orbiting after small movement threshold
      if (this.mouseState.middleDown && !this.orbitingActive) {
        const drag =
          Math.abs(this.mouseState.delta.x) + Math.abs(this.mouseState.delta.y);
        if (drag > 3) {
          this.orbitingActive = true;
          this.orbitingPrimed = false;
          this.canvas!.style.cursor = "grabbing";
        }
      }

      // Only rotate camera if we've actually started dragging
      if (this.orbitingActive) {
        event.preventDefault();
        event.stopPropagation();

        const invert = this.settings.invertY === true ? -1 : 1;
        // modern MMORPG-like: keep rotation responsive when fully zoomed out
        const minR = this.settings.minDistance;
        const maxR = this.settings.maxDistance;
        const r = THREE.MathUtils.clamp(this.spherical.radius, minR, maxR);
        const t = (r - minR) / (maxR - minR); // 0 at min zoom, 1 at max zoom
        const speedScale = THREE.MathUtils.lerp(1.0, 1.3, t); // slightly faster when zoomed out
        const inputScale = this.settings.rotateSpeed * 0.01 * speedScale;
        this.targetSpherical.theta -= this.mouseState.delta.x * inputScale;
        this.targetSpherical.phi -=
          invert * this.mouseState.delta.y * inputScale;
        this.targetSpherical.phi = clamp(
          this.targetSpherical.phi,
          this.settings.minPolarAngle,
          this.settings.maxPolarAngle,
        );
      }

      this.mouseState.lastPosition.set(event.clientX, event.clientY);
      return;
    }
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.button === 2) {
      // Right mouse button
      event.preventDefault();
      event.stopPropagation();
      this.mouseState.rightDown = false;
    }

    if (event.button === 1) {
      // Middle mouse button
      event.preventDefault();
      event.stopPropagation();
      this.mouseState.middleDown = false;
      this.orbitingActive = false;
      this.orbitingPrimed = false;
      this.canvas!.style.cursor = "default";
    }

    if (event.button === 0) {
      // Left mouse button
      this.mouseState.leftDown = false;
      // If we were dragging (orbiting), reset state and prevent click
      if (this.leftDragStarted) {
        event.preventDefault();
        event.stopPropagation();
        this.orbitingActive = false;
        this.orbitingPrimed = false;
        this.canvas!.style.cursor = "default";
        // leftDragStarted stays true briefly so onClickCapture can suppress the click
      } else {
        // No drag occurred - reset orbiting state that was primed
        this.orbitingPrimed = false;
      }
    }
  }

  private onMouseWheel(event: WheelEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // Check if this is a pinch gesture (trackpad two-finger pinch)
    if (event.ctrlKey) {
      // Trackpad pinch: deltaY is proportional to pinch amount
      // Negative = pinch in (zoom out), Positive = spread out (zoom in)
      const pinchSensitivity = 0.05;
      this.targetSpherical.radius -= event.deltaY * pinchSensitivity;
    } else {
      // Regular scroll wheel or trackpad scroll
      const sign = Math.sign(event.deltaY);
      if (sign !== 0) {
        // Discrete notches with modest scaling for trackpads/high-res wheels
        const steps = Math.max(
          1,
          Math.min(5, Math.round(Math.abs(event.deltaY) / 100)),
        );
        this.targetSpherical.radius += sign * steps * this.settings.zoomStep;
      }
    }

    this.targetSpherical.radius = clamp(
      this.targetSpherical.radius,
      this.settings.minDistance,
      this.settings.maxDistance,
    );
    // Snap zoom immediately (no swooping)
    this.spherical.radius = this.targetSpherical.radius;
    this.effectiveRadius = this.targetSpherical.radius;
    this.zoomDirty = true;
    this.lastDesiredRadius = this.spherical.radius;
  }

  private onMouseLeave(_event: MouseEvent): void {
    this.mouseState.rightDown = false;
    this.mouseState.middleDown = false;
    this.mouseState.leftDown = false;
    this.orbitingActive = false;
    this.orbitingPrimed = false;
    this.leftDragStarted = false;
    if (this.canvas) {
      this.canvas.style.cursor = "default";
    }
  }

  private onContextMenu(event: MouseEvent): void {
    // Check if clicking on an entity - if so, let InteractionSystem handle it
    // Use shared RaycastService for zero-allocation entity detection
    if (this.raycastService && this.canvas) {
      const hasEntity = this.raycastService.hasEntityAtPosition(
        event.clientX,
        event.clientY,
        this.canvas,
      );

      if (hasEntity) {
        // Clicking on entity - let InteractionSystem handle it
        return;
      }
    }

    // Not clicking on entity - prevent default context menu
    event.preventDefault();
    event.stopPropagation();
  }

  private onClickCapture(event: MouseEvent): void {
    // Suppress click events if we were dragging to rotate camera
    if (this.leftDragStarted) {
      event.preventDefault();
      event.stopPropagation();
      // Reset the flag after suppressing
      this.leftDragStarted = false;
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Arrow-key camera control: rotate around character only
    const rotateStep = 0.06;
    if (event.code === "ArrowLeft") {
      event.preventDefault();
      // ArrowLeft should rotate view left: decrease theta
      this.targetSpherical.theta -= rotateStep;
      return;
    }
    if (event.code === "ArrowRight") {
      event.preventDefault();
      // ArrowRight should rotate view right: increase theta
      this.targetSpherical.theta += rotateStep;
      return;
    }
    if (event.code === "ArrowUp") {
      event.preventDefault();
      this.targetSpherical.phi = clamp(
        this.targetSpherical.phi - rotateStep,
        this.settings.minPolarAngle,
        this.settings.maxPolarAngle,
      );
      return;
    }
    if (event.code === "ArrowDown") {
      event.preventDefault();
      this.targetSpherical.phi = clamp(
        this.targetSpherical.phi + rotateStep,
        this.settings.minPolarAngle,
        this.settings.maxPolarAngle,
      );
      return;
    }

    if (event.code === "Home" || event.code === "NumpadHome") {
      this.resetCamera();
      event.preventDefault();
    }
  }

  private onKeyUp(_event: KeyboardEvent): void {
    // Reserved for future keyboard camera controls
  }

  private onTouchStart(event: TouchEvent): void {
    // Ignore touches that start on UI elements (so UI remains interactive on mobile)
    const first = event.touches[0];
    if (first) {
      const topEl = document.elementFromPoint(first.clientX, first.clientY);
      if (topEl && this.canvas && topEl !== this.canvas) {
        return;
      }
    }
    // Handle two-finger pinch zoom
    if (event.touches.length === 2) {
      event.preventDefault();
      event.stopPropagation();
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY,
      );

      this.pinchState.active = true;
      this.pinchState.initialDistance = distance;
      this.pinchState.lastDistance = distance;

      // Deactivate single-touch rotation when pinching
      this.touchState.active = false;
      this.orbitingActive = false;
      this.orbitingPrimed = false;
      return;
    }

    // Only handle single-finger touch for camera rotation or tap-to-move
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    this.touchState.active = true;
    this.touchState.touchId = touch.identifier;
    this.touchState.startPosition.set(touch.clientX, touch.clientY);
    this.touchState.lastPosition.set(touch.clientX, touch.clientY);

    // Align targets to current spherical to avoid any initial jump
    this.targetSpherical.theta = this.spherical.theta;
    this.targetSpherical.phi = this.spherical.phi;
    this.orbitingPrimed = true;
    this.orbitingActive = false;

    // Don't prevent default yet - let taps go through
  }

  private onTouchMove(event: TouchEvent): void {
    if (this.touchState.active && event.touches.length === 1) {
      let touch: Touch | null = null;
      for (let i = 0; i < event.touches.length; i++) {
        if (event.touches[i].identifier === this.touchState.touchId) {
          touch = event.touches[i];
          break;
        }
      }
      if (!touch) return;

      const totalDragDistance = Math.hypot(
        touch.clientX - this.touchState.startPosition.x,
        touch.clientY - this.touchState.startPosition.y,
      );
      if (!this.orbitingActive && totalDragDistance > 10) {
        this.orbitingActive = true;
        this.orbitingPrimed = false;
      }

      if (this.orbitingActive) {
        event.preventDefault();
        const deltaX = touch.clientX - this.touchState.lastPosition.x;
        const deltaY = touch.clientY - this.touchState.lastPosition.y;
        const invert = this.settings.invertY ? -1 : 1;
        const inputScale = this.settings.rotateSpeed * 0.008;
        this.targetSpherical.theta -= deltaX * inputScale;
        this.targetSpherical.phi -= invert * deltaY * inputScale;
        this.targetSpherical.phi = clamp(
          this.targetSpherical.phi,
          this.settings.minPolarAngle,
          this.settings.maxPolarAngle,
        );
      }
      this.touchState.lastPosition.set(touch.clientX, touch.clientY);
    } else if (this.pinchState.active && event.touches.length === 2) {
      event.preventDefault();
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY,
      );
      const distanceDelta = this.pinchState.lastDistance - distance;
      const pinchSensitivity = 0.01;
      this.targetSpherical.radius += distanceDelta * pinchSensitivity;
      this.targetSpherical.radius = clamp(
        this.targetSpherical.radius,
        this.settings.minDistance,
        this.settings.maxDistance,
      );
      this.spherical.radius = this.targetSpherical.radius;
      this.effectiveRadius = this.targetSpherical.radius;
      this.zoomDirty = true;
      this.lastDesiredRadius = this.spherical.radius;
      this.pinchState.lastDistance = distance;
    }
  }

  private onTouchEnd(event: TouchEvent): void {
    if (this.touchState.active && !this.orbitingActive) {
      this.world.emit(EventType.CAMERA_TAP, {
        x: this.touchState.startPosition.x,
        y: this.touchState.startPosition.y,
      });
    }

    if (this.pinchState.active && event.touches.length < 2) {
      this.pinchState.active = false;
    }

    let touchFound = false;
    for (let i = 0; i < event.touches.length; i++) {
      if (event.touches[i].identifier === this.touchState.touchId) {
        touchFound = true;
        break;
      }
    }

    if (!touchFound) {
      this.touchState.active = false;
      this.touchState.touchId = -1;
      this.orbitingActive = false;
      this.orbitingPrimed = false;
    }
  }

  private panCamera(deltaX: number, deltaY: number): void {
    if (!this.camera || !this.target) return;

    // Simple pan: move the camera offset in world space based on current camera orientation
    const cameraRight = _v3_1;
    const cameraForward = _v3_2;

    // Get camera right vector
    cameraRight.setFromMatrixColumn(this.camera.matrix, 0).normalize();

    // Get camera forward vector projected on XZ plane
    this.camera.getWorldDirection(cameraForward);
    cameraForward.y = 0;
    cameraForward.normalize();

    const panSpeed = this.settings.panSpeed * 0.01;

    // Apply pan to camera offset
    this.cameraOffset.x -=
      deltaX * panSpeed * cameraRight.x + deltaY * panSpeed * cameraForward.x;
    this.cameraOffset.z -=
      deltaX * panSpeed * cameraRight.z + deltaY * panSpeed * cameraForward.z;
  }

  private resetCamera(): void {
    if (!this.target) return;

    this.targetSpherical.radius = 8;
    this.targetSpherical.theta = Math.PI;
    this.targetSpherical.phi = Math.PI * 0.42;
    this.spherical.radius = this.targetSpherical.radius;
    this.spherical.theta = this.targetSpherical.theta;
    this.spherical.phi = this.targetSpherical.phi;
    // Over-the-shoulder height - lower for better view
    this.cameraOffset.set(0, 1.3, 0);
    this.resetCinematicSamplingState();
  }

  private onSetTarget(event: { target: CameraTarget }): void {
    const previousTarget = this.target;
    this.target = event.target;
    this.resetCinematicSamplingState();

    // Smart cut: measure distance to decide transition style
    if (
      previousTarget &&
      this.isCinematicCameraActive() &&
      this.hasLastKnownPosition &&
      this.getTargetWorldPosition(_v3_1)
    ) {
      const dist = this.lastKnownTargetPosition.distanceTo(_v3_1);
      if (dist > 20) {
        this.cinematicHardCutPending = true;
      } else if (dist > 8) {
        this.cinematicFastSnapRemaining = 0.3;
      }
    }

    if (this.getTargetWorldPosition(_v3_1)) {
      this.logger.info("Target set", {
        x: _v3_1.x,
        y: _v3_1.y,
        z: _v3_1.z,
      });
    }

    if (this.target) {
      if (!this.isCinematicCameraActive() || !previousTarget) {
        this.initializeCameraPosition();
      }
    }
  }

  private onAvatarReady(event: {
    playerId: string;
    avatar: THREE.Object3D;
    camHeight: number;
  }): void {
    // Use avatar height directly without extra offset since player is at terrain level
    this.cameraOffset.y = event.camHeight || 1.6;

    const localPlayer = this.world.getPlayer();

    // Normal player mode: set target to local player
    if (localPlayer && localPlayer.id === event.playerId && !this.target) {
      this.onSetTarget({ target: localPlayer as CameraTarget });
      return;
    }

    // SPECTATOR MODE FIX: If no local player, check if this is a remote player we should follow
    // This happens in spectator mode where we're watching an agent
    if (!localPlayer && !this.target) {
      // Try to find the player entity (could be in items or players map)
      const remotePlayer =
        this.world.entities.items.get(event.playerId) ||
        this.world.entities.players.get(event.playerId);
      if (remotePlayer) {
        this.onSetTarget({ target: remotePlayer as CameraTarget });
      }
    } else if (!localPlayer && this.target) {
      // SPECTATOR FIX: Camera already has target, but avatar just loaded - reinitialize camera position
      // with the correct camHeight now that we know the avatar's actual height
      const targetId = this.target.data?.id;
      if (targetId === event.playerId) {
        this.initializeCameraPosition();
      }
    }
  }

  private initializeCameraPosition(): void {
    if (!this.target || !this.camera) return;

    if (!this.getTargetWorldPosition(_v3_1)) return;

    // Ensure camera is independent before positioning
    this.detachCameraFromRig();

    // Set up orbit center in world space
    const orbitCenter = _v3_1.set(
      _v3_1.x,
      _v3_1.y + this.cameraOffset.y,
      _v3_1.z,
    );
    this.targetPosition.copy(orbitCenter);
    this.smoothedTarget.copy(orbitCenter);
    this.lookAtTarget.copy(orbitCenter);

    this.cameraPosition.setFromSpherical(this.spherical);
    this.cameraPosition.add(orbitCenter);

    // Set camera world position directly (no parent transforms)
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(orbitCenter);

    // Force update matrices since camera has no parent
    this.camera.updateMatrixWorld(true);
  }

  private resolveCinematicContext(): {
    streamPageMode: boolean;
    embeddedSpectatorMode: boolean;
  } {
    if (typeof window === "undefined") {
      return { streamPageMode: false, embeddedSpectatorMode: false };
    }

    return {
      streamPageMode: isStreamPageRoute(),
      embeddedSpectatorMode: isEmbeddedSpectatorViewport(),
    };
  }

  private isCinematicCameraActive(): boolean {
    if (!this.cinematicEnabled || !this.target) {
      return false;
    }

    if (
      this.mouseState.middleDown ||
      (this.mouseState.leftDown && this.leftDragStarted) ||
      this.touchState.active
    ) {
      return false;
    }

    if (this.streamPageMode) {
      return true;
    }

    const hasFreshStreamingSignal =
      Date.now() - this.lastStreamingStateAt <= 120_000;
    return hasFreshStreamingSignal;
  }

  private resolveStreamingCameraTargetId(
    state: StreamingCameraStateUpdate | null,
  ): string | null {
    if (!state) {
      return null;
    }

    if (
      typeof state.cameraTarget === "string" &&
      state.cameraTarget.trim().length > 0
    ) {
      return state.cameraTarget;
    }

    const cycle = state.cycle;
    if (!cycle) {
      return null;
    }

    const phase = cycle.phase ?? "IDLE";
    const agent1Id = cycle.agent1?.id ?? null;
    const agent2Id = cycle.agent2?.id ?? null;
    const winnerId = cycle.winnerId ?? null;

    if (phase === "RESOLUTION" && winnerId) {
      return winnerId;
    }

    return agent1Id || agent2Id || winnerId;
  }

  private tryRetargetFromStreamingState(force = false): boolean {
    if (!this.cinematicEnabled) {
      return false;
    }

    // Dashboard viewfinders are locked to a specific agent — don't let the
    // streaming scheduler's cameraTarget hijack the camera to the duel arena.
    if (this.dashboardFollowMode) {
      return false;
    }

    const targetId = this.resolveStreamingCameraTargetId(
      this.latestStreamingState,
    );
    if (!targetId) {
      return false;
    }

    const currentTargetId = this.target
      ? (this.resolveEntityId(this.resolveTargetEntity(this.target)) ??
        this.resolveEntityId(this.target))
      : null;
    if (!force && currentTargetId === targetId) {
      return true;
    }

    const entity = this.resolveEntityById(targetId);
    if (!entity) {
      if (!this.target) {
        console.warn(
          `[ClientCameraSystem] Streaming target "${targetId}" not found in entity store`,
        );
      }
      return false;
    }

    return this.setCinematicTarget(entity);
  }

  private getStreamingPreparationFocus() {
    const cycle = this.latestStreamingState?.cycle;
    const participantIds = [cycle?.agent1?.id, cycle?.agent2?.id].filter(
      (participantId): participantId is string =>
        typeof participantId === "string" && participantId.length > 0,
    );
    const currentTargetId = this.target
      ? (this.resolveEntityId(this.resolveTargetEntity(this.target)) ??
        this.resolveEntityId(this.target))
      : null;
    const preferredActorId = resolveStreamingPreparationCameraActorId(
      this.latestStreamingState,
      participantIds,
      currentTargetId,
    );
    const equipmentVisuals = this.world.getSystem?.("equipment-visual") as
      | {
          isStreamingPreparationPresentationActive?: (
            playerId: string,
          ) => boolean;
          getStreamingPreparationActivityTargetPosition?: (
            playerIds: readonly string[],
          ) => StreamingPreparationPosition | null;
        }
      | undefined;
    const focus = resolveStreamingPreparationFocus({
      phase: cycle?.phase,
      participantIds,
      preferredActorId,
      resolveEntity: (participantId) =>
        this.resolveEntityById(
          participantId,
        ) as StreamingPreparationEntity | null,
      isParticipantActive: (participantId, entity) =>
        equipmentVisuals?.isStreamingPreparationPresentationActive?.(
          participantId,
        ) === true || hasActiveStreamingPreparationPresentation(entity),
    });
    if (!focus) return null;
    const liveActivityTarget =
      equipmentVisuals?.getStreamingPreparationActivityTargetPosition?.([
        focus.actorId,
      ]) ?? null;
    return liveActivityTarget
      ? { ...focus, activityTargetPosition: liveActivityTarget }
      : focus;
  }

  private hasActiveStreamingPreparation(): boolean {
    return this.getStreamingPreparationFocus() !== null;
  }

  private hasAuthoritativeStreamingIdleTarget(
    state = this.latestStreamingState,
  ): boolean {
    return Boolean(
      state?.cycle?.phase === "IDLE" &&
      typeof state.cameraTarget === "string" &&
      state.cameraTarget.trim().length > 0,
    );
  }

  /**
   * Follow the assigned contestants only while their replicated preparation
   * presentation is active. Polling from update() is intentional: entity
   * snapshots and activity events can arrive after the cycle state without a
   * second streaming-state packet.
   */
  private tryRetargetStreamingPreparation(): boolean {
    if (!this.cinematicEnabled || this.dashboardFollowMode) {
      this.streamingPreparationActive = false;
      this.streamingPreparationFocus = null;
      return false;
    }
    const focus = this.getStreamingPreparationFocus();
    if (!focus) {
      this.streamingPreparationActive = false;
      this.streamingPreparationFocus = null;
      return false;
    }
    this.streamingPreparationActive = true;
    this.streamingPreparationFocus = focus;

    const currentTargetId = this.target
      ? (this.resolveEntityId(this.resolveTargetEntity(this.target)) ??
        this.resolveEntityId(this.target))
      : null;
    if (currentTargetId === focus.actorId) {
      return true;
    }

    const entity = this.resolveEntityById(focus.actorId);
    return entity ? this.setCinematicTarget(entity) : false;
  }

  private rememberStreamingArenaFocus(state: StreamingCameraStateUpdate): void {
    const positions = state.cycle?.arenaPositions;
    if (!positions) {
      return;
    }

    const focus = getStreamingArenaFocus(positions);
    this.streamingArenaTarget.position.set(focus.x, focus.y, focus.z);
    this.hasStreamingArenaFocus = true;
  }

  /** Keep the stream on the ring while cleaned-up fighters return home. */
  private setStreamingArenaTarget(): void {
    if (!this.cinematicEnabled || this.dashboardFollowMode) {
      return;
    }

    if (!this.hasStreamingArenaFocus) {
      const focus = getStreamingArenaFocus(null);
      const terrainHeight = this.getTerrainSystem()?.getHeightAt(
        focus.x,
        focus.z,
      );
      this.streamingArenaTarget.position.set(
        focus.x,
        Number.isFinite(terrainHeight) ? (terrainHeight as number) : focus.y,
        focus.z,
      );
      this.hasStreamingArenaFocus = true;
    }

    if (this.target === this.streamingArenaTarget) {
      return;
    }

    this.onSetTarget({ target: this.streamingArenaTarget });
    this._arenaFallbackApplied = false;
    this.emitTypedEvent(EventType.CAMERA_TARGET_CHANGED, {
      target: this.streamingArenaTarget,
    });
  }

  private isLikelyAgentEntity(entity: unknown): boolean {
    if (!entity || typeof entity !== "object") {
      return false;
    }

    const typed = entity as {
      id?: string;
      type?: string;
      data?: { id?: string; isAgent?: boolean | number };
    };
    const candidateId =
      typed.id ?? typed.data?.id ?? this.resolveEntityId(entity);
    if (typeof candidateId === "string" && candidateId.startsWith("agent-")) {
      return true;
    }
    if (typed.type === "player") {
      return true;
    }
    return typed.data?.isAgent === true || typed.data?.isAgent === 1;
  }

  private isValidSpectatorFallbackEntity(entity: unknown): boolean {
    if (!this.isLikelyAgentEntity(entity)) {
      return false;
    }
    return this.copyEntityPosition(entity, _v3_1);
  }

  private setCinematicTarget(entity: unknown): boolean {
    if (!this.isValidSpectatorFallbackEntity(entity)) {
      return false;
    }

    const target = entity as CameraTarget;
    this.onSetTarget({ target });
    this._arenaFallbackApplied = false;
    this.emitTypedEvent(EventType.CAMERA_TARGET_CHANGED, { target });
    return true;
  }

  private tryAcquireSpectatorFallbackTarget(): boolean {
    if (!this.cinematicEnabled) {
      return false;
    }

    // Dashboard viewfinders should never fall back to streaming-state duel
    // participants — if the target agent isn't loaded yet, just wait.
    if (this.dashboardFollowMode) {
      return false;
    }

    const cycle = this.latestStreamingState?.cycle;
    const resolvedStreamTargetId = this.resolveStreamingCameraTargetId(
      this.latestStreamingState,
    );
    const preferredIds = [
      resolvedStreamTargetId,
      this.latestStreamingState?.cameraTarget ?? null,
      cycle?.winnerId ?? null,
      cycle?.agent1?.id ?? null,
      cycle?.agent2?.id ?? null,
    ];
    for (const preferredId of preferredIds) {
      if (!preferredId) {
        continue;
      }
      const preferredEntity = this.resolveEntityById(preferredId);
      if (preferredEntity && this.setCinematicTarget(preferredEntity)) {
        return true;
      }
    }

    const entities = this.world.entities as {
      players?: Map<string, unknown>;
      items?: Map<string, unknown>;
      getAllEntities?: () => Map<string, unknown>;
    };

    if (entities.players) {
      for (const [, entity] of entities.players) {
        if (!entity) {
          continue;
        }
        if (this.setCinematicTarget(entity)) {
          return true;
        }
      }
    }

    if (entities.items) {
      for (const [, entity] of entities.items) {
        if (!entity) {
          continue;
        }
        if (this.setCinematicTarget(entity)) {
          return true;
        }
      }
    }

    if (entities.getAllEntities) {
      for (const [, entity] of entities.getAllEntities()) {
        if (this.setCinematicTarget(entity)) {
          return true;
        }
      }
    }

    return false;
  }

  private _arenaFallbackApplied = false;

  /** Park the camera at arena one when neither state nor entities exist. */
  private positionCameraAtArenaFallback(): void {
    if (this._arenaFallbackApplied || !this.camera) return;
    const focus = getStreamingArenaFocus(null);
    const terrainHeight = this.getTerrainSystem()?.getHeightAt(
      focus.x,
      focus.z,
    );
    const focusY = Number.isFinite(terrainHeight)
      ? (terrainHeight as number)
      : focus.y;
    this.camera.position.set(focus.x - 15, focusY + 20, focus.z + 25);
    this.camera.lookAt(focus.x, focusY + 2, focus.z);
    this._arenaFallbackApplied = true;
  }

  private getTargetWorldPosition(out: THREE.Vector3): boolean {
    if (!this.target) {
      return false;
    }

    const resolvedTarget = this.resolveTargetEntity(this.target);
    if (this.copyEntityPosition(resolvedTarget, out)) {
      return true;
    }

    return this.copyEntityPosition(this.target, out);
  }

  private resolveEntityById(entityId: string): unknown | null {
    return resolveStreamingEntityByIdentity(
      this.world.entities as StreamingEntityRegistry,
      entityId,
    );
  }

  private resolveEntityId(entity: unknown): string | null {
    return resolveStreamingEntityIdentity(entity);
  }

  private resolveTargetEntity(target: CameraTarget): unknown {
    const directTarget = target as CameraTarget & {
      entity?: unknown;
      id?: string;
      characterId?: string;
    };
    if (directTarget.entity) {
      return directTarget.entity;
    }

    const targetId =
      directTarget.data?.id ||
      directTarget.id ||
      directTarget.characterId ||
      null;
    if (targetId) {
      const entity = this.resolveEntityById(targetId);
      if (entity) {
        return entity;
      }
    }

    return target;
  }

  private copyEntityPosition(entity: unknown, out: THREE.Vector3): boolean {
    if (!entity || typeof entity !== "object") {
      return false;
    }

    const source = entity as {
      position?: unknown;
      base?: {
        position?: unknown;
        getWorldPosition?: (target: THREE.Vector3) => THREE.Vector3;
      };
      node?: {
        position?: unknown;
        getWorldPosition?: (target: THREE.Vector3) => THREE.Vector3;
      };
      data?: { position?: unknown };
      getWorldPosition?: (target: THREE.Vector3) => THREE.Vector3;
    };

    if (typeof source.getWorldPosition === "function") {
      source.getWorldPosition(out);
      return true;
    }

    const rawPosition =
      source.position ?? source.node?.position ?? source.base?.position;

    if (Array.isArray(rawPosition) && rawPosition.length >= 3) {
      const x = Number(rawPosition[0]);
      const y = Number(rawPosition[1]);
      const z = Number(rawPosition[2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        out.set(x, y, z);
        return true;
      }
      return false;
    }

    if (rawPosition && typeof rawPosition === "object") {
      const vector = rawPosition as { x?: number; y?: number; z?: number };
      if (
        Number.isFinite(vector.x) &&
        Number.isFinite(vector.y) &&
        Number.isFinite(vector.z)
      ) {
        out.set(vector.x as number, vector.y as number, vector.z as number);
        return true;
      }
    }

    if (typeof source.node?.getWorldPosition === "function") {
      source.node.getWorldPosition(out);
      return true;
    }

    if (typeof source.base?.getWorldPosition === "function") {
      source.base.getWorldPosition(out);
      return true;
    }

    const dataPosition = source.data?.position;
    if (Array.isArray(dataPosition) && dataPosition.length >= 3) {
      const x = Number(dataPosition[0]);
      const y = Number(dataPosition[1]);
      const z = Number(dataPosition[2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        out.set(x, y, z);
        return true;
      }
      return false;
    }

    if (dataPosition && typeof dataPosition === "object") {
      const vector = dataPosition as { x?: number; y?: number; z?: number };
      if (
        Number.isFinite(vector.x) &&
        Number.isFinite(vector.y) &&
        Number.isFinite(vector.z)
      ) {
        out.set(vector.x as number, vector.y as number, vector.z as number);
        return true;
      }
    }

    return false;
  }

  private resolveOpponentEntity(
    actorEntity: unknown,
    actorId: string | null,
  ): unknown | null {
    const actorData = actorEntity as {
      data?: {
        combatTarget?: string | null;
        ct?: string | null;
        attackTarget?: string | null;
      };
    };

    // Exact published preparation participants outrank stale combat metadata
    // left on an open-world entity. Otherwise a valid ready hold can degrade
    // to a solo shot even though both selected contestants are loaded.
    let opponentId =
      resolveAuthoritativeStreamingPreparationOpponentId(
        this.latestStreamingState,
        actorId,
      ) ||
      actorData.data?.combatTarget ||
      actorData.data?.ct ||
      actorData.data?.attackTarget ||
      null;

    if (!opponentId && actorId && this.latestStreamingState?.cycle) {
      const cycle = this.latestStreamingState.cycle;
      const agent1Id = cycle.agent1?.id ?? null;
      const agent2Id = cycle.agent2?.id ?? null;
      if (actorId === agent1Id && agent2Id) {
        opponentId = agent2Id;
      } else if (actorId === agent2Id && agent1Id) {
        opponentId = agent1Id;
      }
    }

    if (this.latestStreamingState?.cycle?.phase === "IDLE" && opponentId) {
      const opponent = this.resolveEntityById(
        opponentId,
      ) as StreamingPreparationEntity | null;
      const activeParticipantIds = new Set(
        this.getStreamingPreparationFocus()?.participants.map(
          (participant) => participant.id,
        ) ?? [],
      );
      if (
        !isAuthoritativeStreamingPreparationPair(
          this.latestStreamingState,
          actorId,
          opponentId,
        ) &&
        !activeParticipantIds.has(opponentId) &&
        !hasActiveStreamingPreparationPresentation(opponent)
      ) {
        return null;
      }
    }

    if (!opponentId) {
      return null;
    }

    const opponentEntity = this.resolveEntityById(opponentId);
    if (!opponentEntity || opponentEntity === actorEntity) {
      return null;
    }

    return opponentEntity;
  }

  private resetCinematicSamplingState(): void {
    this.cinematicThetaCache = this.spherical.theta;
    this.cinematicThetaCacheValid = false;
    this.cinematicPhiCache = this.spherical.phi;
    this.cinematicPhiCacheValid = false;
    this.cinematicLastLosRefreshAt = 0;
    this.cinematicLastBaseTheta = this.spherical.theta;
    this.cinematicLastHasOpponent = false;
    this.cinematicFacingTheta = this.spherical.theta;
    this.cinematicFacingThetaValid = false;
    this.cinematicPunchIn = 0;
    this.cinematicDramaticLow = 0;
    this.cinematicLastActorHP = null;
    this.cinematicLastOpponentHP = null;
    this.cinematicShakeIntensity = 0;
    this.cinematicHasPrevActorPos = false;
    this.cinematicHasSmoothedY = false;
    this.cinematicLockedActorY = null;
    this.cinematicLockedOpponentY = null;
    this.cinematicLockedSeparation = null;
    this.cinematicFramingSeparation = null;
    this.cinematicSmoothedBiasValid = false;
    this.cinematicVelocity.set(0, 0, 0);
    this.streamingPrevAgent1Hp = null;
    this.streamingPrevAgent2Hp = null;
  }

  private onCinematicPhaseChange(_oldPhase: string, newPhase: string): void {
    // Establish the first broadcast shot immediately, then use a fast damped
    // transition for fight/result changes so phase boundaries do not teleport
    // the camera while viewers are already watching.
    if (newPhase === "ANNOUNCEMENT") {
      this.cinematicHardCutPending = true;
    } else if (
      newPhase === "COUNTDOWN" ||
      newPhase === "FIGHTING" ||
      newPhase === "RESOLUTION"
    ) {
      this.cinematicFastSnapRemaining = 0.45;
    }
    this.cinematicPunchIn = 0;
    this.cinematicDramaticLow = 0;
    this.cinematicShakeIntensity = 0;
    this.cinematicFacingThetaValid = false;
    // Reset Y and separation locks so they re-capture at the new phase's positions
    this.cinematicLockedActorY = null;
    this.cinematicLockedOpponentY = null;
    this.cinematicLockedSeparation = null;
    this.cinematicFramingSeparation = null;
    this.streamingPrevAgent1Hp = null;
    this.streamingPrevAgent2Hp = null;
  }

  private computeCameraShake(dt: number): THREE.Vector3 {
    if (this.cinematicShakeIntensity < 0.001) {
      _cinematicShakeOffset.set(0, 0, 0);
      return _cinematicShakeOffset;
    }
    this.cinematicShakeTime += dt;
    this.cinematicShakeIntensity *= Math.exp(-6.0 * dt);
    if (this.cinematicShakeIntensity < 0.001) {
      this.cinematicShakeIntensity = 0;
    }
    const t = this.cinematicShakeTime * 60;
    const i = this.cinematicShakeIntensity;
    _cinematicShakeOffset.set(
      Math.sin(t * 1.1) * Math.sin(t * 0.47) * i * 0.12,
      Math.sin(t * 1.37) * Math.sin(t * 0.63) * i * 0.04,
      Math.sin(t * 0.93) * Math.sin(t * 0.37) * i * 0.1,
    );
    return _cinematicShakeOffset;
  }

  private moveAngleToward(
    current: number,
    target: number,
    maxSpeedRadPerSec: number,
    deltaSeconds: number,
  ): number {
    const delta = this.shortestAngleDelta(current, target);
    const maxStep = Math.max(0, maxSpeedRadPerSec * deltaSeconds);
    return current + clamp(delta, -maxStep, maxStep);
  }

  private getDampingAlpha(ratePerSecond: number, deltaSeconds: number): number {
    const dt = Math.max(0, deltaSeconds);
    if (ratePerSecond <= 0 || dt <= 0) {
      return 0;
    }
    return clamp(1 - Math.exp(-ratePerSecond * dt), 0, 1);
  }

  private getCinematicLosMask(): number {
    if (this.cinematicLosMask !== null) {
      return this.cinematicLosMask;
    }

    const mask = this.world.createLayerMask(
      "environment",
      "prop",
      "building",
      "obstacle",
      "player",
    );
    this.cinematicLosMask = mask || this.world.createLayerMask("environment");
    return this.cinematicLosMask;
  }

  private getCollisionProbeMask(): number {
    if (this.cinematicCollisionMask !== null) {
      return this.cinematicCollisionMask;
    }

    const mask = this.world.createLayerMask(
      "environment",
      "prop",
      "building",
      "obstacle",
    );
    this.cinematicCollisionMask =
      mask || this.world.createLayerMask("environment");
    return this.cinematicCollisionMask;
  }

  private hasLineOfSight(
    source: THREE.Vector3,
    target: THREE.Vector3,
    occlusionMargin = 0.55,
  ): boolean {
    return this.hasLineOfSightAgainstMask(
      source,
      target,
      occlusionMargin,
      this.getCinematicLosMask(),
    );
  }

  private hasEnvironmentLineOfSight(
    source: THREE.Vector3,
    target: THREE.Vector3,
    occlusionMargin = 0.15,
  ): boolean {
    return (
      this.hasLineOfSightAgainstMask(
        source,
        target,
        occlusionMargin,
        this.getCollisionProbeMask(),
      ) && this.hasTerrainHeightLineOfSight(source, target)
    );
  }

  private hasTerrainHeightLineOfSight(
    source: THREE.Vector3,
    target: THREE.Vector3,
    minimumClearance = 0.08,
  ): boolean {
    const terrain = this.getTerrainSystem();
    if (!terrain) return false;

    const distance = source.distanceTo(target);
    const sampleCount = clamp(Math.ceil(distance / 0.5), 8, 32);
    for (let index = 1; index < sampleCount; index += 1) {
      const alpha = index / sampleCount;
      const x = THREE.MathUtils.lerp(source.x, target.x, alpha);
      const y = THREE.MathUtils.lerp(source.y, target.y, alpha);
      const z = THREE.MathUtils.lerp(source.z, target.z, alpha);
      const terrainHeight = terrain.getHeightAt(x, z);
      if (
        !Number.isFinite(terrainHeight) ||
        y <= terrainHeight + minimumClearance
      ) {
        return false;
      }
    }
    return true;
  }

  private hasLineOfSightAgainstMask(
    source: THREE.Vector3,
    target: THREE.Vector3,
    occlusionMargin: number,
    layerMask: number,
  ): boolean {
    const direction = _cinematicProbeDir.copy(target).sub(source);
    const distance = direction.length();
    if (distance <= 0.001) {
      return true;
    }

    direction.multiplyScalar(1 / distance);
    const hit = this.world.raycast(source, direction, distance, layerMask);
    if (!hit) {
      return true;
    }

    return hit.distance >= distance - occlusionMargin;
  }

  private shouldRefreshCinematicView(
    now: number,
    baseTheta: number,
    actorPosition: THREE.Vector3,
    opponentPosition: THREE.Vector3 | null,
  ): boolean {
    if (!this.cinematicThetaCacheValid || !this.cinematicPhiCacheValid) {
      return true;
    }

    if (now - this.cinematicLastLosRefreshAt >= 500) {
      return true;
    }

    if (
      Math.abs(
        this.shortestAngleDelta(this.cinematicLastBaseTheta, baseTheta),
      ) > 0.35
    ) {
      return true;
    }

    const hasOpponent = Boolean(opponentPosition);
    if (hasOpponent !== this.cinematicLastHasOpponent) {
      return true;
    }

    if (actorPosition.distanceToSquared(this.cinematicLastActorSample) > 0.6) {
      return true;
    }

    if (
      hasOpponent &&
      opponentPosition &&
      opponentPosition.distanceToSquared(this.cinematicLastOpponentSample) > 0.8
    ) {
      return true;
    }

    return false;
  }

  private resolveCinematicView(
    now: number,
    deltaSeconds: number,
    baseTheta: number,
    phi: number,
    radius: number,
    focus: THREE.Vector3,
    actorPosition: THREE.Vector3,
    opponentPosition: THREE.Vector3 | null,
    lockThetaToBase = false,
  ): { theta: number; phi: number } {
    // During active duel combat (COUNTDOWN/FIGHTING/RESOLUTION), skip the
    // periodic LOS grid search entirely. The duel arena is a controlled
    // environment with clear sightlines. The grid search's 500ms refresh
    // cycle causes oscillation when it alternates between rating adjacent
    // angles as "clear" vs "blocked" — the root cause of vertical jitter.
    // Instead, use smooth continuous exponential damping toward the desired
    // angles, giving a heavy, deliberate, film-quality camera feel.
    if (
      this.cinematicPhase === "COUNTDOWN" ||
      this.cinematicPhase === "FIGHTING" ||
      this.cinematicPhase === "RESOLUTION"
    ) {
      if (!this.cinematicThetaCacheValid || !this.cinematicPhiCacheValid) {
        this.cinematicThetaCache = baseTheta;
        this.cinematicPhiCache = phi;
        this.cinematicThetaCacheValid = true;
        this.cinematicPhiCacheValid = true;
      } else {
        // Exponential damping: fast when far from target, slow when close.
        // This is the same approach used by AAA cinematic cameras — no linear
        // rate caps that create mechanical start/stop movement.
        const damp = 1 - Math.exp(-1.8 * deltaSeconds);
        const thetaDelta = this.shortestAngleDelta(
          this.cinematicThetaCache,
          baseTheta,
        );
        this.cinematicThetaCache += thetaDelta * damp;
        this.cinematicPhiCache += (phi - this.cinematicPhiCache) * damp;
      }
      return { theta: this.cinematicThetaCache, phi: this.cinematicPhiCache };
    }

    // IDLE / ANNOUNCEMENT: full LOS grid search (agents roaming the world
    // where buildings and trees can obstruct the view).
    const shouldRefresh = this.shouldRefreshCinematicView(
      now,
      baseTheta,
      actorPosition,
      opponentPosition,
    );

    if (shouldRefresh) {
      const selectedView = this.selectCinematicView(
        baseTheta,
        phi,
        radius,
        focus,
        actorPosition,
        opponentPosition,
        lockThetaToBase,
      );
      const refreshDeltaSeconds = Math.max(
        0.016,
        (now - this.cinematicLastLosRefreshAt) / 1000,
      );

      this.cinematicThetaCache = this.cinematicThetaCacheValid
        ? resolveStreamingCinematicTheta(
            this.cinematicThetaCache,
            selectedView.theta,
            this.cinematicTuning.thetaRefreshRate,
            refreshDeltaSeconds,
            lockThetaToBase,
          )
        : selectedView.theta;
      this.cinematicPhiCache = this.cinematicPhiCacheValid
        ? this.moveAngleToward(
            this.cinematicPhiCache,
            selectedView.phi,
            this.cinematicTuning.phiTargetRate * 0.6,
            refreshDeltaSeconds,
          )
        : selectedView.phi;
      this.cinematicThetaCacheValid = true;
      this.cinematicPhiCacheValid = true;
      this.cinematicLastLosRefreshAt = now;
      this.cinematicLastBaseTheta = baseTheta;
      this.cinematicLastHasOpponent = Boolean(opponentPosition);
      this.cinematicLastActorSample.copy(actorPosition);
      if (opponentPosition) {
        this.cinematicLastOpponentSample.copy(opponentPosition);
      }

      return {
        theta: this.cinematicThetaCache,
        phi: this.cinematicPhiCache,
      };
    }

    // Between LOS refreshes (IDLE/ANNOUNCEMENT only): subtle theta drift,
    // phi stays locked to prevent down-blocked-up oscillation.
    const drift = this.shortestAngleDelta(this.cinematicThetaCache, baseTheta);
    this.cinematicThetaCache = resolveStreamingCinematicTheta(
      this.cinematicThetaCache,
      baseTheta,
      this.cinematicTuning.thetaIdleDriftRate,
      deltaSeconds,
      lockThetaToBase,
    );
    if (!lockThetaToBase) {
      this.cinematicThetaCache += clamp(
        drift * 0.05,
        -this.cinematicTuning.maxDriftStep,
        this.cinematicTuning.maxDriftStep,
      );
    }
    return {
      theta: this.cinematicThetaCache,
      phi: this.cinematicPhiCache,
    };
  }

  private selectCinematicView(
    baseTheta: number,
    phi: number,
    radius: number,
    focus: THREE.Vector3,
    actorPosition: THREE.Vector3,
    opponentPosition: THREE.Vector3 | null,
    lockThetaToBase: boolean,
  ): { theta: number; phi: number } {
    // A two-contestant preparation shot has already selected a context-aware,
    // pair-side theta. Letting the open-world LOS search rotate another 60°
    // puts one contestant in front of the other and defeats that framing
    // guarantee. Keep the pair-side angle exact while retaining vertical LOS
    // alternatives; an obstructed result then fails the existing line-of-sight
    // readiness gate instead of silently becoming an unreadable depth stack.
    const coarseThetaOffsets =
      getStreamingCinematicLosThetaOffsets(lockThetaToBase);
    const coarsePhiOffsets = [0, -0.1, 0.1];
    const fineThetaOffsets = lockThetaToBase
      ? [0]
      : [0, 0.12, -0.12, 0.24, -0.24];
    const finePhiOffsets = [0, -0.05, 0.05];
    let bestScore = -Infinity;
    let bestTheta = baseTheta;
    let bestPhi = phi;
    const seenCandidates = new Set<string>();
    const coarseCandidates: Array<{
      theta: number;
      phi: number;
      score: number;
    }> = [];
    const anchorTheta = this.cinematicThetaCacheValid
      ? this.cinematicThetaCache
      : this.spherical.theta;
    const anchorPhi = this.cinematicPhiCacheValid
      ? this.cinematicPhiCache
      : this.spherical.phi;

    const evaluateCandidate = (theta: number, candidatePhi: number): number => {
      const key = `${theta.toFixed(3)}|${candidatePhi.toFixed(3)}`;
      if (seenCandidates.has(key)) {
        return -Infinity;
      }
      seenCandidates.add(key);
      return this.scoreCinematicViewCandidate({
        theta,
        candidatePhi,
        baseTheta,
        anchorTheta,
        anchorPhi,
        radius,
        focus,
        actorPosition,
        opponentPosition,
      });
    };

    for (const thetaOffset of coarseThetaOffsets) {
      const theta = baseTheta + thetaOffset;

      for (const phiOffset of coarsePhiOffsets) {
        const candidatePhi = clamp(
          phi + phiOffset,
          this.settings.minPolarAngle + 0.01,
          this.settings.maxPolarAngle - 0.01,
        );
        const score = evaluateCandidate(theta, candidatePhi);
        if (score > bestScore) {
          bestScore = score;
          bestTheta = theta;
          bestPhi = candidatePhi;
        }
        if (Number.isFinite(score)) {
          coarseCandidates.push({ theta, phi: candidatePhi, score });
        }
      }
    }

    coarseCandidates.sort((a, b) => b.score - a.score);
    const refineSeeds = coarseCandidates.slice(0, 2);
    for (const seed of refineSeeds) {
      for (const thetaOffset of fineThetaOffsets) {
        const theta = seed.theta + thetaOffset;

        for (const phiOffset of finePhiOffsets) {
          const candidatePhi = clamp(
            seed.phi + phiOffset,
            this.settings.minPolarAngle + 0.01,
            this.settings.maxPolarAngle - 0.01,
          );
          const score = evaluateCandidate(theta, candidatePhi);
          if (score > bestScore) {
            bestScore = score;
            bestTheta = theta;
            bestPhi = candidatePhi;
          }
        }
      }
    }

    return { theta: bestTheta, phi: bestPhi };
  }

  private scoreCinematicViewCandidate(params: {
    theta: number;
    candidatePhi: number;
    baseTheta: number;
    anchorTheta: number;
    anchorPhi: number;
    radius: number;
    focus: THREE.Vector3;
    actorPosition: THREE.Vector3;
    opponentPosition: THREE.Vector3 | null;
  }): number {
    const {
      theta,
      candidatePhi,
      baseTheta,
      anchorTheta,
      anchorPhi,
      radius,
      focus,
      actorPosition,
      opponentPosition,
    } = params;
    const thetaOffset = this.shortestAngleDelta(baseTheta, theta);
    const phiOffset = candidatePhi - anchorPhi;

    _cinematicBestOffset.setFromSpherical(
      _sph_1.set(radius, candidatePhi, theta),
    );
    _cinematicProbePos.copy(focus).add(_cinematicBestOffset);

    let score = -Math.abs(thetaOffset) * 0.62;
    score -= Math.abs(phiOffset) * 0.95;
    score -=
      Math.abs(this.shortestAngleDelta(this.spherical.theta, theta)) * 0.15;
    const turnDelta = Math.abs(this.shortestAngleDelta(anchorTheta, theta));
    score -= turnDelta * 0.95;
    if (turnDelta > this.cinematicTuning.flipPenaltyStartRad) {
      score -= 4.8;
    }
    score -= Math.abs(candidatePhi - anchorPhi) * 1.05;

    // Hysteresis: bias toward the current cached angle to prevent oscillation.
    // The camera only switches when a new angle is substantially better.
    if (this.cinematicThetaCacheValid) {
      const distFromCurrent =
        Math.abs(this.shortestAngleDelta(this.cinematicThetaCache, theta)) +
        Math.abs(this.cinematicPhiCache - candidatePhi);
      if (distFromCurrent < 0.15) {
        score += 2.0;
      }
    }

    const probeDirection = _cinematicProbeDir
      .copy(_cinematicProbePos)
      .sub(focus);
    const probeDistance = probeDirection.length();
    if (probeDistance > 0.001) {
      probeDirection.multiplyScalar(1 / probeDistance);
      const probeHit = this.world.raycast(
        focus,
        probeDirection,
        probeDistance,
        this.getCollisionProbeMask(),
      );
      if (probeHit && probeHit.distance < probeDistance - 0.35) {
        score -= 6.6;
      }
    }

    _cinematicProbeTarget.copy(actorPosition);
    _cinematicProbeTarget.y += 1.05;
    const actorVisible = this.hasLineOfSight(
      _cinematicProbePos,
      _cinematicProbeTarget,
      0.78,
    );
    score += actorVisible ? 6.2 : -7.6;
    _cinematicProbeTarget.copy(actorPosition);
    _cinematicProbeTarget.y += 0.32;
    const actorLowerBodyVisible = this.hasEnvironmentLineOfSight(
      _cinematicProbePos,
      _cinematicProbeTarget,
    );
    score += actorLowerBodyVisible ? 6.2 : -9.2;

    let opponentVisible = false;
    let opponentLowerBodyVisible = false;
    if (opponentPosition) {
      _cinematicProbeTarget.copy(opponentPosition);
      _cinematicProbeTarget.y += 1;
      opponentVisible = this.hasLineOfSight(
        _cinematicProbePos,
        _cinematicProbeTarget,
        0.78,
      );
      score += opponentVisible ? 3.1 : -2.4;
      _cinematicProbeTarget.copy(opponentPosition);
      _cinematicProbeTarget.y += 0.32;
      opponentLowerBodyVisible = this.hasEnvironmentLineOfSight(
        _cinematicProbePos,
        _cinematicProbeTarget,
      );
      score += opponentLowerBodyVisible ? 3.1 : -4.2;
    }

    if (
      actorVisible &&
      actorLowerBodyVisible &&
      (!opponentPosition || (opponentVisible && opponentLowerBodyVisible))
    ) {
      score += 1.15;
    } else if (
      (!actorVisible || !actorLowerBodyVisible) &&
      (!opponentPosition || !opponentVisible || !opponentLowerBodyVisible)
    ) {
      score -= 2.1;
    }

    return score;
  }

  private moveVectorToward(
    current: THREE.Vector3,
    target: THREE.Vector3,
    deltaSeconds: number,
    baseSpeed: number,
    distanceSpeedGain: number,
    maxSpeed: number,
  ): void {
    const distance = current.distanceTo(target);
    if (!Number.isFinite(distance) || distance <= 0.0001) {
      current.copy(target);
      return;
    }

    const speed = clamp(
      baseSpeed + distance * distanceSpeedGain,
      baseSpeed,
      maxSpeed,
    );
    const step = Math.min(distance, speed * Math.max(0, deltaSeconds));
    if (step <= 0) {
      return;
    }
    _cinematicTransitionDir
      .copy(target)
      .sub(current)
      .multiplyScalar(step / distance);
    current.add(_cinematicTransitionDir);
  }

  private applyCinematicLookDirection(): void {
    if (!this.camera) {
      return;
    }

    _cinematicOrientationMatrix.lookAt(
      this.camera.position,
      this.lookAtTarget,
      _cinematicOrientationUp,
    );
    _cinematicOrientationQuat.setFromRotationMatrix(
      _cinematicOrientationMatrix,
    );
    // Position, focus, look-at, theta, and phi are already independently
    // damped before this point. A second slower quaternion smoother lets the
    // camera position orbit ahead of its view direction and can move both
    // contestants outside the crop. Apply the orientation derived from those
    // smoothed inputs exactly so the two-subject midpoint remains centered.
    this.camera.quaternion.copy(_cinematicOrientationQuat);
  }

  /**
   * When streaming duel HP drops, add punch-in + shake so hits read on broadcast.
   */
  private tickStreamingCombatFeedback(deltaSeconds: number): void {
    if (!this.cinematicEnabled || deltaSeconds <= 0) return;
    const cycle = this.latestStreamingState?.cycle;
    if (!cycle || cycle.phase !== "FIGHTING") {
      this.streamingPrevAgent1Hp = null;
      this.streamingPrevAgent2Hp = null;
      return;
    }
    const a1 = cycle.agent1;
    const a2 = cycle.agent2;
    if (!a1 || !a2) return;

    const h1 = typeof a1.hp === "number" ? a1.hp : 0;
    const h2 = typeof a2.hp === "number" ? a2.hp : 0;
    const m1 = Math.max(1, a1.maxHp ?? 1);
    const m2 = Math.max(1, a2.maxHp ?? 1);

    const applyHit = (prev: number | null, next: number, maxHp: number) => {
      if (prev === null) return;
      if (next >= prev - 0.01) return;
      const lost = prev - next;
      const severity = lost / maxHp;
      this.cinematicShakeIntensity = Math.min(
        0.32,
        this.cinematicShakeIntensity + 0.055 + severity * 0.22,
      );
      this.cinematicPunchIn = Math.min(
        1,
        this.cinematicPunchIn + 0.32 + severity * 0.25,
      );
    };

    applyHit(this.streamingPrevAgent1Hp, h1, m1);
    applyHit(this.streamingPrevAgent2Hp, h2, m2);

    this.streamingPrevAgent1Hp = h1;
    this.streamingPrevAgent2Hp = h2;
  }

  private buildCinematicFrame(deltaTime: number): {
    focus: THREE.Vector3;
    lookAt: THREE.Vector3;
    theta: number;
    phi: number;
    radius: number;
    preparationPairShot: boolean;
  } | null {
    if (!this.target || !this.isCinematicCameraActive()) {
      return null;
    }

    const actorEntity = this.resolveTargetEntity(this.target);
    const actorId =
      this.resolveEntityId(actorEntity) ?? this.resolveEntityId(this.target);
    const cycle = this.latestStreamingState?.cycle;
    let hasActorPos =
      this.copyEntityPosition(actorEntity, _cinematicActorPos) ||
      this.copyEntityPosition(this.target, _cinematicActorPos);

    const opponentEntity = this.resolveOpponentEntity(actorEntity, actorId);
    let hasOpponent = opponentEntity
      ? this.copyEntityPosition(opponentEntity, _cinematicOpponentPos)
      : false;
    const resolutionArenaPair = getStreamingResolutionArenaPair(
      cycle?.phase,
      cycle?.arenaPositions,
      cycle?.agent1?.id,
      cycle?.agent2?.id,
      actorId,
    );
    if (
      resolutionArenaPair &&
      !shouldUseStreamingResolutionLivePositions(
        cycle?.phase,
        hasActorPos ? _cinematicActorPos : null,
        hasOpponent ? _cinematicOpponentPos : null,
      )
    ) {
      _cinematicActorPos.fromArray(resolutionArenaPair.actor);
      _cinematicOpponentPos.fromArray(resolutionArenaPair.opponent);
      hasActorPos = true;
      hasOpponent = true;
    }
    if (!hasActorPos) {
      if (this.hasLastKnownPosition) {
        _cinematicActorPos.copy(this.lastKnownTargetPosition);
      } else {
        return null;
      }
    } else {
      this.lastKnownTargetPosition.copy(_cinematicActorPos);
      this.hasLastKnownPosition = true;
    }

    const preparationShot =
      this.cinematicPhase === "IDLE" &&
      (this.streamingPreparationActive ||
        hasAuthoritativeStreamingPreparation(this.latestStreamingState));
    let preparationExcludedOpponent = false;
    if (preparationShot && hasOpponent) {
      const preparationParams = getStreamingPreparationCinematicParams();
      if (
        !shouldFrameStreamingPreparationOpponent(
          getStreamingHorizontalSeparation(
            _cinematicActorPos,
            _cinematicOpponentPos,
          ),
          preparationParams.targetFov,
          this.camera?.aspect,
          Math.min(
            this.settings.maxCinematicDistance,
            preparationParams.radiusMax,
          ),
        )
      ) {
        hasOpponent = false;
        preparationExcludedOpponent = true;
      }
    }

    // Track velocity for movement lead
    if (this.cinematicHasPrevActorPos) {
      this.cinematicVelocity.set(
        _cinematicActorPos.x - this.cinematicPrevActorPos.x,
        0,
        _cinematicActorPos.z - this.cinematicPrevActorPos.z,
      );
    }
    this.cinematicPrevActorPos.copy(_cinematicActorPos);
    this.cinematicHasPrevActorPos = true;

    const now = Date.now();
    const dt = Math.max(0.001, deltaTime || 0.016);

    this.cinematicClock += dt;

    // Lock entity Y during duel combat phases. Entities fight in a flat arena
    // so their Y should be constant. Without locking, TileInterpolator terrain
    // sampling, InterpolationEngine snapshots, and ClientNetwork direct writes
    // all compete for entity.position.y causing frame-to-frame noise that no
    // amount of smoothing can fully eliminate.
    const inDuelCombat =
      this.cinematicPhase === "COUNTDOWN" ||
      this.cinematicPhase === "FIGHTING" ||
      this.cinematicPhase === "RESOLUTION";

    if (inDuelCombat) {
      // Lock Y on first frame of duel combat, or if not yet locked
      if (this.cinematicLockedActorY === null) {
        this.cinematicLockedActorY = _cinematicActorPos.y;
      }
      if (hasOpponent && this.cinematicLockedOpponentY === null) {
        this.cinematicLockedOpponentY = _cinematicOpponentPos.y;
      }
      // Use locked Y — completely ignores noisy terrain/interpolation updates
      _cinematicActorPos.y = this.cinematicLockedActorY;
      if (hasOpponent) {
        _cinematicOpponentPos.y = this.cinematicLockedOpponentY!;
      }
    } else {
      // Outside duel combat, clear locks and use gentle smoothing for idle following
      this.cinematicLockedActorY = null;
      this.cinematicLockedOpponentY = null;
      this.cinematicLockedSeparation = null;
      this.cinematicFramingSeparation = null;

      if (!this.cinematicHasSmoothedY) {
        this.cinematicSmoothedActorY = _cinematicActorPos.y;
        this.cinematicSmoothedOpponentY = hasOpponent
          ? _cinematicOpponentPos.y
          : _cinematicActorPos.y;
        this.cinematicHasSmoothedY = true;
      } else {
        const ySmooth = 1 - Math.exp(-0.5 * dt);
        this.cinematicSmoothedActorY +=
          (_cinematicActorPos.y - this.cinematicSmoothedActorY) * ySmooth;
        if (hasOpponent) {
          this.cinematicSmoothedOpponentY +=
            (_cinematicOpponentPos.y - this.cinematicSmoothedOpponentY) *
            ySmooth;
        }
      }
      _cinematicActorPos.y = this.cinematicSmoothedActorY;
      if (hasOpponent) {
        _cinematicOpponentPos.y = this.cinematicSmoothedOpponentY;
      }
    }

    // Phase-aware camera parameters
    const pp = preparationShot
      ? getStreamingPreparationCinematicParams()
      : getStreamingCinematicPhaseParams(this.cinematicPhase);
    const baseTargetFov = getStreamingCinematicTargetFov(
      this.cinematicPhase,
      pp.targetFov,
      this.cinematicPunchIn,
    );

    // Movement lead offset (camera anticipates movement direction)
    const leadScale = getStreamingCinematicLeadScale(
      this.cinematicPhase,
      preparationShot && hasOpponent,
    );
    const speed = Math.sqrt(
      this.cinematicVelocity.x * this.cinematicVelocity.x +
        this.cinematicVelocity.z * this.cinematicVelocity.z,
    );
    _cinematicLeadOffset.set(0, 0, 0);
    if (speed > 0.02) {
      _cinematicLeadOffset.set(
        this.cinematicVelocity.x * leadScale,
        0,
        this.cinematicVelocity.z * leadScale,
      );
    }

    if (hasOpponent) {
      const rawSeparation = _cinematicActorPos.distanceTo(
        _cinematicOpponentPos,
      );
      const horizontalSeparation = getStreamingHorizontalSeparation(
        _cinematicActorPos,
        _cinematicOpponentPos,
      );

      // Keep the phase composition/pitch anchored to the opening separation,
      // but never use that stale value to size a live two-subject frame. The
      // framing envelope expands immediately as fighters kite apart and eases
      // inward when they close, preventing both crop failures and radius pumping.
      if (inDuelCombat) {
        if (this.cinematicLockedSeparation === null) {
          this.cinematicLockedSeparation = rawSeparation;
        }
        this.cinematicFramingSeparation = getStreamingAdaptiveFramingSeparation(
          this.cinematicFramingSeparation,
          rawSeparation,
          dt,
        );
      } else {
        this.cinematicLockedSeparation = null;
        this.cinematicFramingSeparation = null;
      }
      const compositionSeparation =
        this.cinematicLockedSeparation ?? rawSeparation;
      const framingSeparation =
        this.cinematicFramingSeparation ?? rawSeparation;

      // Focus point: phase-aware bias between actor and opponent.
      // Smooth the bias transition to prevent Y jumps when phase changes
      // (e.g., ANNOUNCEMENT bias=0.35 → FIGHTING bias=0.58 would cause
      // an instant focus-point jump if actor and opponent have different Y).
      if (!this.cinematicSmoothedBiasValid) {
        this.cinematicSmoothedBias = pp.focusBias;
        this.cinematicSmoothedBiasValid = true;
      } else {
        const biasSmooth = 1 - Math.exp(-2.0 * dt);
        this.cinematicSmoothedBias +=
          (pp.focusBias - this.cinematicSmoothedBias) * biasSmooth;
      }
      const bias = this.cinematicSmoothedBias;
      _cinematicFocusPos
        .copy(_cinematicActorPos)
        .multiplyScalar(bias)
        .add(
          _cinematicProbeTarget
            .copy(_cinematicOpponentPos)
            .multiplyScalar(1 - bias),
        );
      _cinematicFocusPos.y += 1.05;
      _cinematicFocusPos.add(_cinematicLeadOffset);

      _cinematicLookAtPos
        .copy(_cinematicActorPos)
        .add(_cinematicOpponentPos)
        .multiplyScalar(0.5);
      _cinematicLookAtPos.y += getStreamingCinematicLookAtHeight(
        this.cinematicPhase,
        preparationShot,
        Math.abs(_cinematicActorPos.y - _cinematicOpponentPos.y),
      );

      // Facing theta (smoothed toward opponent direction)
      let facingTheta = this.cinematicFacingTheta;
      if (rawSeparation > 0.25) {
        const rawFacingTheta = getStreamingCanonicalPairFacingTheta(
          _cinematicActorPos,
          _cinematicOpponentPos,
          actorId,
          cycle?.agent1?.id,
          cycle?.agent2?.id,
        );
        if (!this.cinematicFacingThetaValid || preparationShot) {
          this.cinematicFacingTheta = rawFacingTheta;
          this.cinematicFacingThetaValid = true;
        } else {
          this.cinematicFacingTheta = resolveStreamingCinematicTheta(
            this.cinematicFacingTheta,
            rawFacingTheta,
            getStreamingCinematicFacingTurnRate(this.cinematicPhase),
            dt,
          );
        }
        facingTheta = this.cinematicFacingTheta;
      } else if (!this.cinematicFacingThetaValid) {
        this.cinematicFacingTheta = this.spherical.theta;
        this.cinematicFacingThetaValid = true;
        facingTheta = this.cinematicFacingTheta;
      }

      const t = this.cinematicClock;
      // Orbit drift with phase-controlled amplitude (bounded sines only — never
      // add t * driftSpeed: that is unbounded and reads as endless camera spin.)
      const amp = pp.orbitAmplitude;
      const orbitDrift =
        Math.sin(t * 0.17) * amp +
        Math.sin(t * 0.089 + 2.1) * amp * 0.73 +
        Math.sin(t * 0.31 + 0.7) * amp * 0.4 +
        Math.sin(t * pp.driftSpeed * 2.5 + 0.2) * amp * 0.35;
      const bigSwingRaw = Math.sin(t * 0.048) * Math.sin(t * 0.032) * amp * 2.3;
      const bigSwing =
        this.cinematicPhase === "FIGHTING" ? bigSwingRaw * 0.2 : bigSwingRaw;

      let baseTheta =
        facingTheta +
        getStreamingCinematicSideAngle(this.cinematicPhase) +
        orbitDrift +
        bigSwing;
      if (preparationShot) {
        baseTheta = getStreamingPreparationPairSideOnTheta(
          facingTheta,
          _cinematicFocusPos,
          this.streamingPreparationFocus?.activityTargetPosition ?? null,
        );
      }

      // Phase-aware radius — use smoothstep blend instead of hard threshold
      // to prevent discrete jumps when agents hover near 3 units apart
      const closeCombatBlend = clamp((3.5 - compositionSeparation) / 1.5, 0, 1);
      const combatTightening = closeCombatBlend * 1.2;
      const separationRadiusScale = getStreamingCinematicSeparationRadiusScale(
        this.cinematicPhase,
        preparationShot,
      );
      const preparationRadiusBounds = preparationShot
        ? getStreamingPreparationPairRadiusBounds(
            Math.abs(_cinematicActorPos.y - _cinematicOpponentPos.y),
          )
        : { radiusMin: pp.radiusMin, radiusMax: pp.radiusMax };
      const baseRadius = clamp(
        pp.radiusMin +
          framingSeparation * separationRadiusScale -
          combatTightening,
        preparationRadiusBounds.radiusMin,
        preparationRadiusBounds.radiusMax,
      );
      let radius = clamp(
        baseRadius + Math.sin(t * 0.32) * 0.2,
        preparationRadiusBounds.radiusMin,
        preparationRadiusBounds.radiusMax,
      );
      if (this.cinematicPhase === "FIGHTING") {
        radius *= 1 - this.cinematicPunchIn * 0.05;
        radius = clamp(radius, pp.radiusMin * 0.86, pp.radiusMax);
      }
      const aspectFraming = getStreamingAspectFraming(
        radius,
        baseTargetFov,
        this.camera?.aspect,
        this.settings.maxCinematicDistance,
      );
      const preparationSeparationRadius = preparationShot
        ? getStreamingPreparationSeparationRadius(
            aspectFraming.radius,
            horizontalSeparation,
            aspectFraming.targetFov,
            this.camera?.aspect,
          )
        : aspectFraming.radius;
      radius = getStreamingSeparationAwareRadius(
        preparationSeparationRadius,
        preparationShot ? horizontalSeparation : framingSeparation,
        aspectFraming.targetFov,
        this.camera?.aspect,
        this.settings.maxCinematicDistance,
      );
      this.cinematicTargetFov = aspectFraming.targetFov;

      // Phase-aware phi (pitch angle) — smooth blend for close combat
      let phi: number;
      if (this.cinematicPhase === "RESOLUTION") {
        // Low heroic angle for winner
        phi = clamp(
          pp.basePhi + Math.sin(t * 0.09) * 0.03,
          this.settings.minPolarAngle + 0.03,
          this.settings.maxPolarAngle - 0.01,
        );
      } else if (this.cinematicPhase === "COUNTDOWN") {
        // Tight hero shot, slight variation
        phi = clamp(
          pp.basePhi + Math.sin(t * 0.11) * 0.02,
          this.settings.minPolarAngle + 0.03,
          this.settings.maxPolarAngle - 0.03,
        );
      } else {
        // FIGHTING / IDLE blend toward a lower close-combat angle. Announcement
        // deliberately keeps its authored elevated pitch: the contestants are
        // staged close together, and treating that as combat made the opening
        // shot too low, horizon-heavy, and visually small.
        // Use only time-based variation (no separation dependency) to prevent
        // discontinuous phi changes when agents move during combat.
        const closeCombatPhi =
          this.cinematicPhase === "ANNOUNCEMENT"
            ? pp.basePhi
            : pp.basePhi + closeCombatBlend * (Math.PI * 0.38 - pp.basePhi);
        const phiVariation =
          Math.sin(t * 0.13) * 0.015 + Math.sin(t * 0.07) * 0.01;
        phi = clamp(
          closeCombatPhi + phiVariation,
          this.settings.minPolarAngle + 0.03,
          this.settings.maxPolarAngle - 0.03,
        );
      }

      const cinematicView = this.resolveCinematicView(
        now,
        dt,
        baseTheta,
        phi,
        radius,
        _cinematicFocusPos,
        _cinematicActorPos,
        _cinematicOpponentPos,
        preparationShot,
      );

      return {
        focus: _cinematicFocusPos,
        lookAt: _cinematicLookAtPos,
        theta: cinematicView.theta,
        phi: cinematicView.phi,
        radius,
        preparationPairShot: preparationShot,
      };
    }

    // Solo (no opponent) — phase-aware
    this.cinematicFacingThetaValid = false;
    _cinematicFocusPos.copy(_cinematicActorPos);
    _cinematicFocusPos.y += 1;
    _cinematicFocusPos.add(_cinematicLeadOffset);
    _cinematicLookAtPos.copy(_cinematicActorPos);
    _cinematicLookAtPos.y += 1.12;

    const tSolo = this.cinematicClock;
    const soloAmp = pp.orbitAmplitude;
    const thetaDrift =
      Math.sin(tSolo * 0.15) * soloAmp * 0.5 +
      Math.sin(tSolo * 0.067 + 1.3) * soloAmp * 0.4 +
      Math.sin(tSolo * pp.driftSpeed * 2.5 + 0.2) * soloAmp * 0.35;
    let baseTheta = this.spherical.theta + thetaDrift;
    if (preparationShot) {
      baseTheta = getStreamingPreparationSoloCameraTheta(
        _cinematicActorPos,
        preparationExcludedOpponent ? _cinematicOpponentPos : null,
        this.streamingPreparationFocus?.activityTargetPosition ?? null,
        baseTheta,
      );
    }
    const baseRadius = clamp(
      (pp.radiusMin + pp.radiusMax) * 0.5 +
        Math.sin(tSolo * 0.34) * 0.3 +
        Math.sin(tSolo * 0.12 + 0.8) * 0.2,
      pp.radiusMin,
      pp.radiusMax,
    );
    const aspectFraming = getStreamingAspectFraming(
      baseRadius,
      baseTargetFov,
      this.camera?.aspect,
      this.settings.maxCinematicDistance,
    );
    const radius = aspectFraming.radius;
    this.cinematicTargetFov = aspectFraming.targetFov;
    const phi = clamp(
      pp.basePhi +
        Math.sin(tSolo * 0.13 + 0.6) * 0.05 +
        Math.sin(tSolo * 0.07) * 0.03,
      this.settings.minPolarAngle + 0.02,
      this.settings.maxPolarAngle - 0.02,
    );
    const cinematicView = this.resolveCinematicView(
      now,
      dt,
      baseTheta,
      phi,
      radius,
      _cinematicFocusPos,
      _cinematicActorPos,
      null,
      preparationExcludedOpponent,
    );

    return {
      focus: _cinematicFocusPos,
      lookAt: _cinematicLookAtPos,
      theta: cinematicView.theta,
      phi: cinematicView.phi,
      radius,
      preparationPairShot: false,
    };
  }

  update(deltaTime: number): void {
    if (!this.camera) return;
    if (
      this.cinematicEnabled &&
      !this.dashboardFollowMode &&
      this.latestStreamingState?.cycle?.phase === "IDLE"
    ) {
      if (
        !this.tryRetargetStreamingPreparation() &&
        !this.tryRetargetFromStreamingState()
      ) {
        this.setStreamingArenaTarget();
      }
    }
    if (!this.target) {
      this.tryAcquireLocalPlayerTarget();
      this.tryRetargetFromStreamingState();
      // Avoid locking onto arbitrary bystanders before the first streaming state
      // arrives; this prevents an initial hard retarget once state sync lands.
      const hasStreamingStateSignal =
        this.latestStreamingState !== null || this.lastStreamingStateAt > 0;
      const allowSpectatorFallback =
        !this.cinematicEnabled || hasStreamingStateSignal;
      if (allowSpectatorFallback) {
        this.tryAcquireSpectatorFallbackTarget();
      }
      if (!this.target) {
        // In streaming/spectator mode with no entities, park the camera at the
        // duel arena lobby so the stream shows the arena instead of void.
        // Dashboard viewfinders should NOT do this — they're waiting for their
        // specific agent entity to load, not looking at the arena.
        if (this.cinematicEnabled && !this.dashboardFollowMode) {
          this.positionCameraAtArenaFallback();
        }
        return;
      }
    }

    const frameDt = Math.max(0.001, deltaTime || 0.016);
    this.tickStreamingCombatFeedback(frameDt);

    // Safety check: ensure camera is still detached from rig
    if (this.camera.parent === this.world.rig) {
      console.warn(
        "[ClientCameraSystem] Camera re-attached to rig, detaching again",
      );
      this.detachCameraFromRig();
    }

    const cinematicFrame = this.buildCinematicFrame(deltaTime);
    this.streamingPreparationPairShotActive =
      cinematicFrame?.preparationPairShot === true;
    if (cinematicFrame) {
      this.targetPosition.copy(cinematicFrame.focus);

      // Handle hard cuts and fast snaps
      if (this.cinematicHardCutPending) {
        // Hard cut: snap everything instantly
        this.smoothedTarget.copy(this.targetPosition);
        this.targetSpherical.radius = cinematicFrame.radius;
        this.targetSpherical.phi = cinematicFrame.phi;
        this.targetSpherical.theta = cinematicFrame.theta;
        this.spherical.radius = cinematicFrame.radius;
        this.spherical.phi = cinematicFrame.phi;
        this.spherical.theta = cinematicFrame.theta;
        this.effectiveRadius = cinematicFrame.radius;
        this.lookAtTarget.copy(cinematicFrame.lookAt);
        this.cinematicHardCutPending = false;
        this.cinematicFastSnapRemaining = 0;
      } else {
        // Single-layer exponential damping for all cinematic smoothing.
        // Exponential decay (fast when far, slow when close) produces the
        // heavy, deliberate camera motion of AAA cinematic cameras like RDR2.
        // This replaces the previous 3-layer pipeline (cinematicCache →
        // targetSpherical → spherical) which had conflicting linear rate
        // caps that created mechanical start/stop motion and oscillation.
        //
        // Rate 3.5 → half-life ~0.2s, reaches 95% in ~0.6s.
        // Presentation position rate 5.0 retains authored weight. FIGHTING uses
        // a faster midpoint response so authoritative tile steps cannot push
        // either full silhouette through the HUD-safe crop.
        const snapM = this.cinematicFastSnapRemaining > 0 ? 3.0 : 1.0;
        if (this.cinematicFastSnapRemaining > 0) {
          this.cinematicFastSnapRemaining = Math.max(
            0,
            this.cinematicFastSnapRemaining - frameDt,
          );
        }

        // Position: exponential damping (unified X/Y/Z — no separate Y rate limit).
        // Y is locked during duel combat so there's no terrain noise to filter.
        const posDamp =
          1 -
          Math.exp(
            -getStreamingCinematicPositionDampingRate(this.cinematicPhase) *
              snapM *
              frameDt,
          );
        this.smoothedTarget.lerp(this.targetPosition, posDamp);
        this.lookAtTarget.lerp(cinematicFrame.lookAt, posDamp);

        // Angles: single-layer exponential damping directly to cinematicFrame
        // values. No intermediate targetSpherical — that extra layer added
        // latency and created phase conflicts between smoothers.
        const angleDamp =
          1 -
          Math.exp(
            -getStreamingCinematicAngleDampingRate(
              this.cinematicPhase,
              cinematicFrame.preparationPairShot,
            ) *
              snapM *
              frameDt,
          );
        this.targetSpherical.theta = dampStreamingCinematicTheta(
          this.targetSpherical.theta,
          cinematicFrame.theta,
          getStreamingCinematicAngleDampingRate(
            this.cinematicPhase,
            cinematicFrame.preparationPairShot,
          ) * snapM,
          frameDt,
          cinematicFrame.preparationPairShot
            ? Math.PI / 18
            : Number.POSITIVE_INFINITY,
        );
        this.targetSpherical.phi +=
          (cinematicFrame.phi - this.targetSpherical.phi) * angleDamp;
        this.targetSpherical.radius = dampStreamingCinematicRadius(
          this.targetSpherical.radius,
          cinematicFrame.radius,
          frameDt,
          snapM,
        );
      }
    } else {
      let hasTargetPosition = this.getTargetWorldPosition(_v3_1);
      if (!hasTargetPosition) {
        if (this.tryRetargetFromStreamingState(true)) {
          hasTargetPosition = this.getTargetWorldPosition(_v3_1);
        }
        if (!hasTargetPosition && this.tryAcquireSpectatorFallbackTarget()) {
          hasTargetPosition = this.getTargetWorldPosition(_v3_1);
        }
        if (!hasTargetPosition) {
          if (this.hasLastKnownPosition) {
            _v3_1.copy(this.lastKnownTargetPosition);
          } else {
            return;
          }
        }
      }

      // Save last known good position
      this.lastKnownTargetPosition.copy(_v3_1);
      this.hasLastKnownPosition = true;

      // For server-authoritative movement, follow target directly without smoothing.
      this.targetPosition.copy(_v3_1);
      this.targetPosition.add(this.cameraOffset);

      // modern MMORPG: no target smoothing; follow the player position directly to avoid any lag/jitter
      this.smoothedTarget.copy(this.targetPosition);
    }

    // Apply spherical smoothing only while orbiting. When not orbiting, snap to target to avoid drift.
    const rotationDamping = this.settings.rotationDampingFactor;
    const isOrbiting =
      this.mouseState.middleDown ||
      (this.mouseState.leftDown && this.leftDragStarted) ||
      this.touchState.active;
    const shouldSmoothSpherical = isOrbiting || Boolean(cinematicFrame);
    if (shouldSmoothSpherical) {
      if (cinematicFrame) {
        // In cinematic mode, targetSpherical already contains the smoothed
        // values (single-layer exponential damping applied above). Copy
        // directly — adding a second smoothing layer creates sluggishness
        // and can cause oscillation when the two layers have different rates.
        this.spherical.phi = this.targetSpherical.phi;
        this.spherical.theta = this.targetSpherical.theta;
      } else {
        const phiDelta = this.targetSpherical.phi - this.spherical.phi;
        const thetaDelta = this.shortestAngleDelta(
          this.spherical.theta,
          this.targetSpherical.theta,
        );
        if (Math.abs(phiDelta) > 1e-5) {
          this.spherical.phi += phiDelta * rotationDamping;
        } else {
          this.spherical.phi = this.targetSpherical.phi;
        }
        if (Math.abs(thetaDelta) > 1e-5) {
          this.spherical.theta += thetaDelta * rotationDamping;
        } else {
          this.spherical.theta = this.targetSpherical.theta;
        }
      }
    } else {
      this.spherical.phi = this.targetSpherical.phi;
      this.spherical.theta = this.targetSpherical.theta;
    }

    // In cinematic mode, propagate targetSpherical.radius → spherical.radius
    // (the cinematic frame sets targetSpherical.radius but the smoothing block
    // above only handles phi/theta)
    if (cinematicFrame) {
      this.spherical.radius = this.targetSpherical.radius;
    }

    // Hard clamp after smoothing to enforce strict modern MMORPG-like limits
    this.spherical.radius = clamp(
      this.spherical.radius,
      this.settings.minDistance,
      cinematicFrame
        ? this.settings.maxCinematicDistance
        : this.settings.maxDistance,
    );

    // Collision-aware effective radius — skip in cinematic mode because the
    // LOS scorer already avoids obstructed camera angles. Running the collision
    // raycast here causes jitter as the ray alternates between hitting and
    // missing terrain at different orbit angles each frame.
    if (cinematicFrame) {
      this.effectiveRadius = this.spherical.radius;
    } else {
      const desiredDistance = this.spherical.radius;
      const collidedDistance =
        this.computeCollisionAdjustedDistance(desiredDistance);
      const targetEffective = Math.min(desiredDistance, collidedDistance);
      if (this.zoomDirty || this.orbitingActive) {
        this.effectiveRadius = targetEffective;
      } else {
        const radiusDamping = this.settings.radiusDampingFactor ?? 0.18;
        this.effectiveRadius +=
          (targetEffective - this.effectiveRadius) * radiusDamping;
      }
    }

    // Calculate camera position from spherical coordinates using effective radius
    const tempSpherical = _sph_1.set(
      this.effectiveRadius,
      this.spherical.phi,
      this.spherical.theta,
    );
    this.cameraPosition.setFromSpherical(tempSpherical);
    this.cameraPosition.add(this.smoothedTarget);

    // The cinematic candidate search avoids terrain, but angular damping can
    // briefly interpolate through a ridge between two valid views. Keep a
    // small emergency clearance in cinematic mode; normal play retains its
    // larger shoulder-camera clearance.
    this.clampAboveTerrain(this.cameraPosition, cinematicFrame ? 0.75 : 1.5);

    if (!cinematicFrame) {
      // Calculate look-at target - look at player's chest/torso height
      this.lookAtTarget.copy(this.smoothedTarget);
      // Over-the-shoulder: look at shoulder/upper chest height
      this.lookAtTarget.y = this.smoothedTarget.y + 0.2;

      // Apply over-the-shoulder offset (Fortnite-style)
      // When zoomed in close, offset the look-at target horizontally so character appears on left/right
      const zoomFactor = THREE.MathUtils.clamp(
        (this.settings.maxDistance - this.effectiveRadius) /
          (this.settings.maxDistance - this.settings.minDistance),
        0,
        1,
      );
      const shoulderOffset = this.settings.shoulderOffsetMax * zoomFactor;

      // Calculate the right vector relative to camera's current orientation
      const cameraRight = _v3_1
        .set(Math.cos(this.spherical.theta), 0, Math.sin(this.spherical.theta))
        .normalize();

      // Apply horizontal offset to look-at target
      this.lookAtTarget.x +=
        cameraRight.x * shoulderOffset * this.settings.shoulderOffsetSide;
      this.lookAtTarget.z +=
        cameraRight.z * shoulderOffset * this.settings.shoulderOffsetSide;
    }

    // Follow target. If zoom changed this frame, snap position instantly for straight-in/out motion
    // modern MMORPG: move camera directly with no positional lerp to avoid swoop or lag
    this.camera.position.copy(this.cameraPosition);
    if (cinematicFrame) {
      this.camera.position.add(this.computeCameraShake(frameDt));
    }
    this.zoomDirty = false;

    if (cinematicFrame) {
      this.applyCinematicLookDirection();
    } else {
      // Camera always looks at the lookAt target
      // This keeps the player centered regardless of avatar rotation
      this.camera.lookAt(this.lookAtTarget);
    }

    // Dynamic FOV for cinematic mode
    if (cinematicFrame && this.camera) {
      const fovDelta = this.cinematicTargetFov - this.camera.fov;
      if (Math.abs(fovDelta) > 0.1) {
        this.camera.fov += clamp(fovDelta, -15 * frameDt, 15 * frameDt);
        this.camera.updateProjectionMatrix();
      }
    }

    // Update camera matrices since it has no parent transform to inherit from
    this.camera.updateMatrixWorld(true);

    this.cinematicPunchIn *= Math.exp(-2.85 * frameDt);
  }

  /** Cached collision raycast result — avoid raycasting every single frame */
  private _lastCollisionRaycastTime = 0;
  private _cachedCollisionDistance = 0;
  private _lastCollisionDesired = 0;
  private static readonly COLLISION_RAYCAST_THROTTLE_MS = 80;

  private computeCollisionAdjustedDistance(desiredDistance: number): number {
    if (!this.camera || !this.target) return desiredDistance;

    // Throttle raycasts: reuse cached result if camera hasn't moved much
    const now = performance.now();
    if (
      now - this._lastCollisionRaycastTime <
        ClientCameraSystem.COLLISION_RAYCAST_THROTTLE_MS &&
      Math.abs(desiredDistance - this._lastCollisionDesired) < 0.1
    ) {
      return this._cachedCollisionDistance;
    }

    // Direction from orbit center (smoothed target) to ideal camera position
    const dir = _v3_3
      .set(
        this.cameraPosition.x - this.smoothedTarget.x,
        this.cameraPosition.y - this.smoothedTarget.y,
        this.cameraPosition.z - this.smoothedTarget.z,
      )
      .normalize();

    const origin = _v3_2.set(
      this.smoothedTarget.x,
      this.smoothedTarget.y,
      this.smoothedTarget.z,
    );
    const hit = this.world.raycast(
      origin,
      dir,
      desiredDistance,
      this.getCollisionProbeMask(),
    );

    let result: number;
    // Strong type assumption - RaycastHit.distance is always number
    if (hit && hit.distance > 0) {
      const minDist = this.settings.minDistance;
      const margin = 0.4;
      result = Math.max(
        Math.min(desiredDistance, hit.distance - margin),
        minDist,
      );
    } else {
      result = desiredDistance;
    }

    this._lastCollisionRaycastTime = now;
    this._lastCollisionDesired = desiredDistance;
    this._cachedCollisionDistance = result;
    return result;
  }

  private getTerrainSystem(): TerrainSystem | null {
    if (this.terrainSystemRef === undefined) {
      this.terrainSystemRef =
        (this.world.getSystem("terrain") as TerrainSystem | null) ?? null;
    }
    return this.terrainSystemRef;
  }

  private clampAboveTerrain(pos: THREE.Vector3, minClearance: number): void {
    const terrain = this.getTerrainSystem();
    if (!terrain) return;
    // getHeightAt() is bridge-aware — returns deck height on bridge tiles
    const height = terrain.getHeightAt(pos.x, pos.z);
    if (Number.isFinite(height) && pos.y < height + minClearance) {
      pos.y = height + minClearance;
    }
  }

  private onStreamingStateHP(_state: StreamingCameraStateUpdate): void {
    // Intentionally empty — all combat-reactive camera effects (punch-in,
    // shake, dramatic low angle) have been removed for a smooth cinematic
    // experience. HP changes no longer affect the camera.
  }

  private shortestAngleDelta(a: number, b: number): number {
    let delta = (b - a) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  // Public API methods for testing and external access
  public setTarget(target: CameraTarget): void {
    this.onSetTarget({ target });
    this.emitTypedEvent(EventType.CAMERA_TARGET_CHANGED, { target });
  }

  public getCameraInfo(): {
    camera: THREE.PerspectiveCamera | null;
    target: CameraTarget | null;
    offset: number[];
    position: number[] | null;
    isControlling: boolean;
    spherical: { radius: number; phi: number; theta: number };
    preparationShotActive: boolean;
    preparationPairShotActive: boolean;
  } {
    // Use pre-allocated arrays to avoid memory allocations
    _cameraInfoOffset[0] = this.cameraOffset.x;
    _cameraInfoOffset[1] = this.cameraOffset.y;
    _cameraInfoOffset[2] = this.cameraOffset.z;

    let position: number[] | null = null;
    if (this.camera) {
      _cameraInfoPosition[0] = this.camera.position.x;
      _cameraInfoPosition[1] = this.camera.position.y;
      _cameraInfoPosition[2] = this.camera.position.z;
      position = _cameraInfoPosition;
    }

    return {
      camera: this.camera,
      target: this.target,
      offset: _cameraInfoOffset,
      position: position,
      isControlling:
        this.mouseState.middleDown ||
        (this.mouseState.leftDown && this.leftDragStarted) ||
        this.touchState.active,
      spherical: {
        radius: this.spherical.radius,
        phi: this.spherical.phi,
        theta: this.spherical.theta,
      },
      preparationShotActive:
        this.cinematicPhase === "IDLE" &&
        (this.streamingPreparationActive ||
          hasAuthoritativeStreamingPreparation(this.latestStreamingState)),
      preparationPairShotActive: this.streamingPreparationPairShotActive,
    };
  }

  /**
   * Probe the real scene collision layers from the current broadcast camera to
   * a contestant body point. This is diagnostic-only: it cannot steer or
   * mutate the camera while live acceptance measures an obstructed shot.
   */
  public getStreamingCinematicLineOfSight(
    target: StreamingCameraPosition | null | undefined,
  ): boolean | null {
    if (
      !this.camera ||
      !target ||
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      !Number.isFinite(target.z)
    ) {
      return null;
    }

    _cinematicProbeTarget.set(target.x, target.y, target.z);
    return this.hasLineOfSight(
      this.camera.position,
      _cinematicProbeTarget,
      0.65,
    );
  }

  /**
   * Probe environment-only lower-body visibility with a tight target margin.
   * Excluding player colliders avoids treating the contestant's own capsule as
   * terrain while head/torso probes still detect contestant depth overlap.
   */
  public getStreamingCinematicEnvironmentLineOfSight(
    target: StreamingCameraPosition | null | undefined,
  ): boolean | null {
    if (
      !this.camera ||
      !target ||
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      !Number.isFinite(target.z)
    ) {
      return null;
    }

    _cinematicProbeTarget.set(target.x, target.y, target.z);
    return this.hasEnvironmentLineOfSight(
      this.camera.position,
      _cinematicProbeTarget,
    );
  }

  destroy(): void {
    if (this.canvas) {
      // Remove capture phase listeners
      this.canvas.removeEventListener(
        "mousedown",
        this.boundHandlers.mouseDown as EventListener,
        true,
      );
      this.canvas.removeEventListener(
        "mousemove",
        this.boundHandlers.mouseMove as EventListener,
        true,
      );
      this.canvas.removeEventListener(
        "mouseup",
        this.boundHandlers.mouseUp as EventListener,
        true,
      );
      this.canvas.removeEventListener(
        "wheel",
        this.boundHandlers.mouseWheel as EventListener,
        true,
      );
      this.canvas.removeEventListener(
        "mouseleave",
        this.boundHandlers.mouseLeave as EventListener,
        true,
      );
      this.canvas.removeEventListener(
        "contextmenu",
        this.boundHandlers.contextMenu as EventListener,
        true,
      );
      this.canvas.removeEventListener(
        "click",
        this.boundHandlers.click as EventListener,
        true,
      );
      document.removeEventListener(
        "keydown",
        this.boundHandlers.keyDown as EventListener,
      );
      document.removeEventListener(
        "keyup",
        this.boundHandlers.keyUp as EventListener,
      );

      // Clean up touch events
      this.canvas.removeEventListener(
        "touchstart",
        this.boundHandlers.touchStart as EventListener,
      );
      this.canvas.removeEventListener(
        "touchmove",
        this.boundHandlers.touchMove as EventListener,
      );
      this.canvas.removeEventListener(
        "touchend",
        this.boundHandlers.touchEnd as EventListener,
      );
      this.canvas.removeEventListener(
        "touchcancel",
        this.boundHandlers.touchEnd as EventListener,
      );

      this.canvas.style.cursor = "default";
    }

    this.camera = null;
    this.target = null;
    this.canvas = null;
    this.raycastService = null;
    this.cinematicLosMask = null;
    this.cinematicCollisionMask = null;
    this.terrainSystemRef = undefined;
    this.hasLastKnownPosition = false;
    this.hasStreamingArenaFocus = false;
    this.resetCinematicSamplingState();
  }

  // Required System lifecycle methods
  preTick(): void {}
  preFixedUpdate(): void {}
  fixedUpdate(_dt: number): void {}
  postFixedUpdate(): void {}
  preUpdate(): void {}
  postUpdate(): void {}
  lateUpdate(): void {}
  postLateUpdate(): void {}
  commit(): void {}
  postTick(): void {}
}
