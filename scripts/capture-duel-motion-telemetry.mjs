#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import {
  buildDefaultCaptureLaunchArgs,
  resolveDefaultCaptureFeatureFlags,
  applyCaptureFrameRateToUrl,
  CANONICAL_CAPTURE_RENDER_PROFILE,
} from "../packages/server/src/streaming/captureBrowserPolicy.ts";
import {
  attachStreamingViewerToken,
  duelCaptureStatesAgree,
  evaluateDuelSceneCapture,
  normalizeDuelCaptureState,
} from "./duel-capture-scenarios.mjs";
import {
  DUEL_MOTION_TELEMETRY_LIMITS,
  cloneDuelScreenshotPerformanceSnapshot,
  evaluateDuelScreenshotPerformanceSnapshot,
  evaluateDuelStyleSwitchTelemetry,
  isDuelMotionSamplingRace,
  parseDuelMotionRoles,
  parseDuelMotionSafeCrop,
  summarizeDuelHitReactionResolutionTelemetry,
  summarizeDuelHitReactionTelemetry,
  summarizeDuelStyleSwitchTelemetry,
  summarizeDuelMotionTelemetry,
} from "./duel-motion-telemetry.mjs";
import {
  selectDuelRangedPresentationEvents,
  summarizeDuelRangedTransitionTelemetry,
} from "./duel-ranged-transition-telemetry.mjs";
import { accumulateFightingObservation } from "./duel-fighting-observation.mjs";

const COMBAT_ROLES = new Set(["melee", "ranged", "mage"]);
const MAX_RETAINED_SAMPLES = 600;
const MAX_RETAINED_ERRORS = 100;
const MAX_RETAINED_SCREENSHOT_ATTEMPTS = 4;
const SCREENSHOT_PERFORMANCE_TIMEOUT_MS = 3_000;

async function readScreenshotPerformanceProbe(page, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      page.evaluate(() => ({
        clock: {
          wallTimeMs: Date.now(),
          timeOrigin: performance.timeOrigin,
          performanceNowMs: performance.now(),
        },
        performance: window.__HYPERIA_STREAM_PERFORMANCE__ ?? null,
      })),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Screenshot performance probe timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForScreenshotPerformance(page, attempt, immediateProbe) {
  const deadline = performance.now() + SCREENSHOT_PERFORMANCE_TIMEOUT_MS;
  let probe = immediateProbe;
  while (true) {
    attempt.afterPerformance = cloneDuelScreenshotPerformanceSnapshot(
      probe.performance,
    );
    attempt.afterSnapshotClock = probe.clock;
    if (probe.clock.timeOrigin !== attempt.beforeClock.timeOrigin) {
      throw new Error("Screenshot browser clock epoch changed");
    }
    attempt.snapshotFreshness = evaluateDuelScreenshotPerformanceSnapshot({
      before: attempt.beforePerformance,
      after: attempt.afterPerformance,
      captureEndedAt: attempt.immediateAfterClock.wallTimeMs,
      afterObservedAt: probe.clock.wallTimeMs,
    });
    if (attempt.snapshotFreshness.status === "invalid") {
      throw new Error(attempt.snapshotFreshness.reason);
    }
    if (attempt.snapshotFreshness.status === "ready") {
      return attempt.afterPerformance;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new Error(
        "Screenshot performance snapshot did not advance within 3000ms",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, remainingMs)),
    );
    const probeTimeoutMs = deadline - performance.now();
    if (probeTimeoutMs <= 0) {
      throw new Error(
        "Screenshot performance snapshot did not advance within 3000ms",
      );
    }
    probe = await readScreenshotPerformanceProbe(page, probeTimeoutMs);
  }
}

const options = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "stream-url": {
      type: "string",
      default: "http://localhost:3333/stream.html",
    },
    "state-url": {
      type: "string",
      default: "http://localhost:5555/api/streaming/state",
    },
    "output-dir": {
      type: "string",
      default: "artifacts/duel-arena-motion-telemetry",
    },
    roles: { type: "string", default: "ranged,mage" },
    "multi-style": { type: "boolean" },
    "require-hit-reactions": { type: "boolean" },
    "require-ranged-transitions": { type: "boolean" },
    "network-latency-ms": { type: "string", default: "0" },
    "cpu-throttle-rate": { type: "string", default: "1" },
    "duration-s": { type: "string", default: "240" },
    "minimum-fighting-s": { type: "string" },
    "maximum-duration-s": { type: "string" },
    "startup-timeout-s": { type: "string", default: "180" },
    "poll-ms": { type: "string", default: "100" },
    viewport: { type: "string", default: "1920x1080" },
    "safe-ndc-x": { type: "string" },
    "safe-ndc-y": { type: "string" },
    headed: { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
  },
  strict: true,
}).values;

if (options.help) {
  console.log(`
Read-only production-shaped duel motion and 60 FPS capture gate.

Usage:
  bun scripts/capture-duel-motion-telemetry.mjs [options]

Options:
  --stream-url <url>   Canonical stream page (the versioned 720p60 source profile is enforced)
  --state-url <url>    Authenticated public state API
  --output-dir <path>  New evidence directory; an existing manifest is never overwritten
  --roles <csv>        Exact fixed pair, or melee,ranged,mage in multi-style mode
  --multi-style        Require both contestants to switch frozen combat roles live
  --require-hit-reactions Require repeated health/reaction alignment in the real avatar mixer
  --require-ranged-transitions Require repeated live nock/release/flight/impact/reaction continuity
  --network-latency-ms <n> Browser transport latency in milliseconds (0-2000)
  --cpu-throttle-rate <n> Browser CPU slowdown multiplier (1-20)
  --duration-s <n>     Minimum wall-clock capture window (default: 240)
  --minimum-fighting-s <n> Required accepted FIGHTING time; ranged-transition default: 60
  --maximum-duration-s <n> Hard wall-clock timeout; defaults to max(duration, 4x FIGHTING target)
  --startup-timeout-s <n> Separate cold scene-admission timeout (default: 180)
  --poll-ms <n>        Browser/server poll interval (default: 100)
  --viewport <WxH>     Browser viewport (default: 1920x1080)
  --safe-ndc-x <n>     Optional maximum absolute fighter projection X (0,1]
  --safe-ndc-y <n>     Optional maximum absolute fighter projection Y (0,1]
  --headed             Show Chromium
  --verbose, -v        Print bounded progress every five seconds

The gate does not mutate combat or outcomes. It retains authoritative browser
scene samples only while browser/server public state agrees during FIGHTING,
then verifies movement, diagonal and directional coverage, facing, rotation,
transform agreement, arena containment, and renderer frame percentiles.
Viewer and state credentials are accepted only through
STREAMING_CAPTURE_VIEWER_TOKEN and STREAMING_CAPTURE_STATE_TOKEN and are never
written to evidence. When no distinct state token is supplied, the viewer
token also authorizes the state cross-check so both probes use the same
authoritative timeline instead of mixing live and intentionally delayed state.
`);
  process.exit(0);
}

function parseBoundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const normalized = Number.isSafeInteger(parsed) ? parsed : fallback;
  if (normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function parseBoundedNumber(value, fallback, minimum, maximum, label) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  if (normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function parseViewport(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(String(value ?? "").trim());
  if (!match) throw new TypeError("viewport must use WIDTHxHEIGHT format");
  return {
    width: parseBoundedInteger(match[1], 0, 320, 7680, "viewport width"),
    height: parseBoundedInteger(match[2], 0, 320, 4320, "viewport height"),
  };
}

function parseHttpUrl(value, label) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError(`${label} cannot contain credentials or a fragment`);
  }
  return url;
}

function publicUrl(url) {
  const copy = new URL(url);
  copy.search = "";
  copy.hash = "";
  return copy.toString();
}

function boundedMessage(value, maximumLength = 500) {
  return String(value ?? "")
    .replace(/(?:https?|wss?):\/\/[^\s)'"<>]+/gi, (candidate) => {
      try {
        return publicUrl(new URL(candidate));
      } catch {
        return "redacted-url";
      }
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function redactRequestUrl(value) {
  try {
    return publicUrl(new URL(value));
  } catch {
    return "invalid-url";
  }
}

function increment(counter, key) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function fetchState(url, bearerToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`state HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function readBrowserProbe(page) {
  return page.evaluate(() => {
    const runtimeWindow = window;
    const documentElement = document.documentElement;
    const body = document.body;
    const sceneReadiness =
      runtimeWindow.__HYPERIA_STREAM_SCENE_READINESS__ ?? null;
    const equipment = sceneReadiness?.equipmentVisuals ?? null;
    const counter = (value) =>
      Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {
      clock: {
        wallTimeMs: Date.now(),
        timeOrigin: performance.timeOrigin,
        performanceNowMs: performance.now(),
      },
      state: runtimeWindow.__HYPERIA_STREAM_STATE__ ?? null,
      rendererHealth: runtimeWindow.__HYPERIA_STREAM_RENDERER_HEALTH__ ?? null,
      performance: runtimeWindow.__HYPERIA_STREAM_PERFORMANCE__ ?? null,
      sceneDiagnostics:
        runtimeWindow.__HYPERIA_STREAM_SCENE_DIAGNOSTICS__ ?? null,
      equipmentReadiness:
        sceneReadiness && equipment
          ? {
              ready: sceneReadiness.ready === true,
              cycleId:
                typeof sceneReadiness.cycleId === "string"
                  ? sceneReadiness.cycleId
                  : null,
              phase:
                typeof sceneReadiness.phase === "string"
                  ? sceneReadiness.phase
                  : null,
              equipmentVisualsReady:
                sceneReadiness.equipmentVisualsReady === true,
              configured: equipment.configured === true,
              equipmentCycleId:
                typeof equipment.cycleId === "string"
                  ? equipment.cycleId
                  : null,
              requiredCount: counter(equipment.requiredCount),
              requiredPlayerCount: counter(equipment.requiredPlayerCount),
              readyCount: counter(equipment.readyCount),
              expectedPlayerCount: counter(equipment.expectedPlayerCount),
              activeVisualCount: counter(equipment.activeVisualCount),
              activeVisibleCount: counter(equipment.activeVisibleCount),
              activePlayerCount: counter(equipment.activePlayerCount),
              activeVisiblePlayerCount: counter(
                equipment.activeVisiblePlayerCount,
              ),
              unresolvedCount: Array.isArray(equipment.unresolved)
                ? equipment.unresolved.length
                : null,
              attachmentMismatchCount: Array.isArray(
                equipment.attachmentMismatches,
              )
                ? equipment.attachmentMismatches.length
                : null,
            }
          : null,
      layout: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: Math.max(
          documentElement.scrollWidth,
          body?.scrollWidth ?? 0,
        ),
        scrollHeight: Math.max(
          documentElement.scrollHeight,
          body?.scrollHeight ?? 0,
        ),
        canvasCount: document.querySelectorAll("canvas").length,
        activeHudCount: document.querySelectorAll(".streaming-duel-info")
          .length,
        errorOverlayCount: document.querySelectorAll(
          "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
        ).length,
        activeCombatRoles: Array.from(
          document.querySelectorAll("[data-active-combat-role]"),
        )
          .map((element) => element.getAttribute("data-active-combat-role"))
          .filter(Boolean),
        styleSwitchEventCount: document.querySelectorAll(
          '[data-event-kind="style_switch"]',
        ).length,
      },
    };
  });
}

function hasExactVisibleFightingEquipment(
  equipment,
  cycleId,
  expectedAgentCount = 2,
) {
  return Boolean(
    equipment?.ready === true &&
    equipment?.phase === "FIGHTING" &&
    equipment?.cycleId === cycleId &&
    equipment?.equipmentVisualsReady === true &&
    equipment?.configured === true &&
    equipment?.equipmentCycleId === cycleId &&
    equipment?.requiredPlayerCount === expectedAgentCount &&
    equipment?.expectedPlayerCount === expectedAgentCount &&
    equipment?.activePlayerCount === expectedAgentCount &&
    equipment?.activeVisiblePlayerCount === expectedAgentCount &&
    Number.isSafeInteger(equipment?.requiredCount) &&
    equipment.requiredCount >= expectedAgentCount &&
    equipment?.readyCount === equipment.requiredCount &&
    Number.isSafeInteger(equipment?.activeVisualCount) &&
    equipment.activeVisualCount >= expectedAgentCount &&
    equipment?.activeVisibleCount === equipment.activeVisualCount &&
    equipment?.unresolvedCount === 0 &&
    equipment?.attachmentMismatchCount === 0,
  );
}

function exactDiagnosticRole(agent) {
  const roles = [...new Set(agent?.availableCombatStyles ?? [])].filter(
    (role) => COMBAT_ROLES.has(role),
  );
  return roles.length === 1 ? roles[0] : null;
}

function resolveFrozenCombatRole(agent) {
  if (agent?.loadoutFrozen !== true) return null;
  const weaponId = agent?.equipment?.weapon;
  if (typeof weaponId !== "string" || !weaponId.trim()) return null;
  const allowedRoles = new Set(agent?.availableCombatStyles ?? []);
  const matches = [...COMBAT_ROLES].filter((role) => {
    if (!allowedRoles.has(role)) return false;
    const loadout = agent?.combatLoadouts?.[role];
    return loadout?.role === role && loadout?.weaponId === weaponId;
  });
  return matches.length === 1 ? matches[0] : null;
}

function roleSetMatches(roles, expectedRoles) {
  return (
    JSON.stringify([...roles].sort()) ===
    JSON.stringify([...expectedRoles].sort())
  );
}

function publicRoleStateMatches(publicAgents, expectedRoles, multiStyle) {
  if (!multiStyle) {
    return roleSetMatches(publicAgents.map(exactDiagnosticRole), expectedRoles);
  }
  return publicAgents.every((agent) => {
    const available = [...new Set(agent?.availableCombatStyles ?? [])].filter(
      (role) => COMBAT_ROLES.has(role),
    );
    const loadoutRoles = Object.keys(agent?.combatLoadouts ?? {}).filter(
      (role) => COMBAT_ROLES.has(role),
    );
    return (
      roleSetMatches(available, expectedRoles) &&
      roleSetMatches(loadoutRoles, expectedRoles) &&
      resolveFrozenCombatRole(agent) !== null
    );
  });
}

function buildMotionSample(browserState, diagnostics, observedAt, multiStyle) {
  const publicAgents = [
    browserState?.cycle?.agent1,
    browserState?.cycle?.agent2,
  ];
  const roles = publicAgents.map((agent) =>
    multiStyle ? resolveFrozenCombatRole(agent) : exactDiagnosticRole(agent),
  );
  const combatStats = publicAgents.map((agent) => ({
    hp: Number(agent?.hp),
    maxHp: Number(agent?.maxHp),
    attacksLanded: Number(agent?.attacksLanded),
  }));
  if (roles.some((role) => role == null)) return null;
  if (
    combatStats.some(
      ({ hp, maxHp, attacksLanded }) =>
        !Number.isFinite(hp) ||
        hp < 0 ||
        !Number.isFinite(maxHp) ||
        maxHp <= 0 ||
        hp > maxHp ||
        !Number.isSafeInteger(attacksLanded) ||
        attacksLanded < 0,
    )
  ) {
    return null;
  }
  if (diagnostics.agents.some((agent) => agent == null)) return null;
  return {
    observedAt,
    sceneUpdatedAt: diagnostics.updatedAt,
    cycleId: diagnostics.cycleId,
    renderedSeparationXZ: diagnostics.renderedSeparationXZ,
    agents: diagnostics.agents.map((agent, index) => ({
      id: agent.id,
      role: roles[index],
      hp: combatStats[index].hp,
      maxHp: combatStats[index].maxHp,
      attacksLanded: combatStats[index].attacksLanded,
      renderPosition: agent.renderPosition,
      simulationPosition: agent.simulationPosition,
      avatarPosition: agent.avatarPosition,
      renderQuaternion: agent.renderQuaternion,
      ndcPosition: agent.ndcPosition,
      ndcHeadPosition: agent.ndcHeadPosition,
      facingTargetErrorDegrees: agent.facingTargetErrorDegrees,
      insideCombatArena: agent.insideCombatArena,
      insideAssignedCombatArena: agent.insideAssignedCombatArena,
      cameraLineOfSight: agent.cameraLineOfSight ?? null,
      visible: agent.visible,
      active: agent.active,
      avatarReady: agent.avatarReady,
      hitReaction: agent.hitReaction ?? null,
      authoredMotion: agent.authoredMotion ?? null,
      avatarEmote: agent.avatarEmote ?? null,
    })),
  };
}

function buildHitReactionLifecycleSample(state, diagnostics, observedAt) {
  if (
    !state ||
    !["FIGHTING", "RESOLUTION"].includes(state.phase) ||
    diagnostics.cycleId !== state.cycleId ||
    diagnostics.phase !== state.phase
  ) {
    return null;
  }
  const publicAgents = [state.agent1, state.agent2];
  if (
    publicAgents.some((agent) => agent == null) ||
    diagnostics.agents.some(
      (agent, index) => !agent || agent.id !== publicAgents[index]?.id,
    )
  ) {
    return null;
  }
  return {
    observedAt,
    sceneUpdatedAt: diagnostics.updatedAt,
    cycleId: state.cycleId,
    phase: state.phase,
    agents: diagnostics.agents.map((agent, index) => ({
      id: agent.id,
      hp: publicAgents[index].hp,
      hitReaction: agent.hitReaction ?? null,
      authoredMotion: agent.authoredMotion ?? null,
      avatarEmote: agent.avatarEmote ?? null,
    })),
  };
}

function finitePositionTuple(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const tuple = value.map(Number);
  return tuple.every(Number.isFinite) ? tuple : null;
}

function buildRangedTransitionSnapshot(
  rawSceneDiagnostics,
  normalizedDiagnostics,
  roles,
  observedAt,
) {
  lastRangedTransitionDiagnosticRejectionReason = null;
  const rangedPlayerIds = normalizedDiagnostics.agents.flatMap(
    (agent, index) => (agent && roles[index] === "ranged" ? [agent.id] : []),
  );
  const duelPlayerIds = new Set(
    normalizedDiagnostics.agents.flatMap((agent) =>
      agent?.id ? [agent.id] : [],
    ),
  );
  const presentation = rawSceneDiagnostics?.combatPresentation;
  const bow = presentation?.bow;
  const projectiles = presentation?.projectiles;
  const damage = presentation?.damage;
  if (
    bow?.schemaVersion !== 1 ||
    projectiles?.schemaVersion !== 1 ||
    damage?.schemaVersion !== 1 ||
    !Number.isFinite(bow.performanceTimeMs) ||
    !Number.isSafeInteger(bow.latestSequence) ||
    bow.latestSequence < 0 ||
    !Number.isSafeInteger(projectiles.latestSequence) ||
    projectiles.latestSequence < 0 ||
    !Number.isSafeInteger(projectiles.latestImpactSequence) ||
    projectiles.latestImpactSequence < 0 ||
    !Number.isSafeInteger(projectiles.latestCancellationSequence) ||
    projectiles.latestCancellationSequence < 0 ||
    !Number.isSafeInteger(damage.latestSequence) ||
    damage.latestSequence < 0 ||
    !Array.isArray(bow.players) ||
    !Array.isArray(bow.recentTransitions) ||
    !Array.isArray(projectiles.activeArrows) ||
    !Array.isArray(projectiles.recentArrowSpawns) ||
    !Array.isArray(projectiles.recentArrowImpacts) ||
    !Array.isArray(projectiles.recentArrowCancellations) ||
    !Array.isArray(damage.recentEvents) ||
    !Number.isSafeInteger(projectiles.arrowCancelledBeforeSpawnCount) ||
    projectiles.arrowCancelledBeforeSpawnCount < 0 ||
    !Number.isSafeInteger(projectiles.arrowExpiredBeforeImpactCount) ||
    projectiles.arrowExpiredBeforeImpactCount < 0
  ) {
    lastRangedTransitionDiagnosticRejectionReason = "schema_invalid";
    return null;
  }

  const roleByPlayerId = new Map(
    normalizedDiagnostics.agents.flatMap((agent, index) =>
      agent?.id && typeof roles[index] === "string"
        ? [[agent.id, roles[index]]]
        : [],
    ),
  );
  const players = bow.players
    .filter((player) => duelPlayerIds.has(player?.playerId))
    .map((player) => ({
      playerId: player.playerId,
      role: roleByPlayerId.get(player.playerId) ?? null,
      itemId:
        typeof player.itemId === "string" && player.itemId.length <= 160
          ? player.itemId
          : null,
      controllerReady: player.controllerReady === true,
      nockedArrowVisible: player.nockedArrowVisible === true,
      nockedArrowWorldPosition:
        player.nockedArrowWorldPosition == null
          ? null
          : finitePositionTuple(player.nockedArrowWorldPosition),
    }));
  if (
    players.length !== duelPlayerIds.size ||
    players.some((player) => typeof player.role !== "string") ||
    players.some(
      (player) => player.nockedArrowVisible && !player.nockedArrowWorldPosition,
    )
  ) {
    lastRangedTransitionDiagnosticRejectionReason = "players_invalid";
    return null;
  }

  const normalizeTransition = (transition) => {
    if (
      !Number.isSafeInteger(transition?.sequence) ||
      transition.sequence < 0 ||
      !duelPlayerIds.has(transition.playerId) ||
      !["scheduled", "released", "cancelled"].includes(transition.kind) ||
      !Number.isFinite(transition.performanceTimeMs)
    ) {
      return null;
    }
    const normalized = {
      sequence: transition.sequence,
      playerId: transition.playerId,
      itemId:
        typeof transition.itemId === "string" && transition.itemId.length <= 160
          ? transition.itemId
          : null,
      kind: transition.kind,
      performanceTimeMs: transition.performanceTimeMs,
      networkEventId:
        typeof transition.networkEventId === "string" &&
        transition.networkEventId.length > 0 &&
        transition.networkEventId.length <= 256
          ? transition.networkEventId
          : null,
    };
    if (transition.kind === "scheduled") {
      return Number.isFinite(transition.releaseAtPerformanceTimeMs)
        ? {
            ...normalized,
            releaseAtPerformanceTimeMs: transition.releaseAtPerformanceTimeMs,
          }
        : null;
    }
    if (transition.kind === "released") {
      const lastVisibleNockWorldPosition = finitePositionTuple(
        transition.lastVisibleNockWorldPosition,
      );
      const drawHandWorldPosition = finitePositionTuple(
        transition.drawHandWorldPosition,
      );
      return lastVisibleNockWorldPosition && drawHandWorldPosition
        ? {
            ...normalized,
            lastVisibleNockWorldPosition,
            drawHandWorldPosition,
          }
        : null;
    }
    return normalized;
  };
  const normalizeSpawn = (spawn, active = false) => {
    const startPosition = finitePositionTuple(spawn?.startPosition);
    const targetPosition = finitePositionTuple(spawn?.targetPosition);
    const currentPosition = active
      ? finitePositionTuple(spawn?.currentPosition)
      : null;
    if (
      !Number.isSafeInteger(spawn?.sequence) ||
      spawn.sequence < 0 ||
      !duelPlayerIds.has(spawn.attackerId) ||
      typeof spawn.targetId !== "string" ||
      spawn.targetId.length === 0 ||
      spawn.targetId.length > 160 ||
      typeof spawn.projectileId !== "string" ||
      spawn.projectileId.length === 0 ||
      spawn.projectileId.length > 160 ||
      !Number.isFinite(spawn.performanceTimeMs) ||
      !startPosition ||
      !targetPosition ||
      (active &&
        (!currentPosition ||
          !Number.isFinite(spawn.elapsedMs) ||
          spawn.elapsedMs < 0 ||
          !Number.isFinite(spawn.distanceTraveled) ||
          spawn.distanceTraveled < 0 ||
          !Number.isFinite(spawn.flightProgress) ||
          spawn.flightProgress < 0 ||
          spawn.flightProgress > 1))
    ) {
      return null;
    }
    return {
      sequence: spawn.sequence,
      attackerId: spawn.attackerId,
      targetId: spawn.targetId,
      projectileId: spawn.projectileId,
      arrowId:
        typeof spawn.arrowId === "string" && spawn.arrowId.length <= 160
          ? spawn.arrowId
          : null,
      networkEventId:
        typeof spawn.networkEventId === "string" &&
        spawn.networkEventId.length > 0 &&
        spawn.networkEventId.length <= 160
          ? spawn.networkEventId
          : null,
      performanceTimeMs: spawn.performanceTimeMs,
      startPosition,
      targetPosition,
      travelDurationMs: Number.isFinite(spawn.travelDurationMs)
        ? spawn.travelDurationMs
        : null,
      ...(active
        ? {
            currentPosition,
            elapsedMs: spawn.elapsedMs,
            distanceTraveled: spawn.distanceTraveled,
            flightProgress: spawn.flightProgress,
          }
        : {}),
    };
  };
  const normalizeImpact = (impact) => {
    const impactPosition =
      impact?.impactPosition === null
        ? null
        : finitePositionTuple(impact?.impactPosition);
    if (
      !Number.isSafeInteger(impact?.sequence) ||
      impact.sequence < 0 ||
      !duelPlayerIds.has(impact.attackerId) ||
      typeof impact.targetId !== "string" ||
      !duelPlayerIds.has(impact.targetId) ||
      typeof impact.projectileId !== "string" ||
      impact.projectileId.length === 0 ||
      impact.projectileId.length > 160 ||
      typeof impact.networkEventId !== "string" ||
      impact.networkEventId.length === 0 ||
      impact.networkEventId.length > 160 ||
      !Number.isFinite(impact.performanceTimeMs) ||
      !Number.isFinite(impact.damage) ||
      impact.damage < 0 ||
      !(
        impact.travelledMetres === null ||
        (Number.isFinite(impact.travelledMetres) && impact.travelledMetres >= 0)
      ) ||
      !(
        impact.flightProgress === null ||
        (Number.isFinite(impact.flightProgress) &&
          impact.flightProgress >= 0 &&
          impact.flightProgress <= 1)
      ) ||
      typeof impact.visualFound !== "boolean" ||
      !Number.isSafeInteger(impact.impactParticleCount) ||
      impact.impactParticleCount < 0 ||
      (impact.impactPosition !== null && !impactPosition)
    ) {
      return null;
    }
    return {
      sequence: impact.sequence,
      launchSequence: Number.isSafeInteger(impact.launchSequence)
        ? impact.launchSequence
        : null,
      attackerId: impact.attackerId,
      targetId: impact.targetId,
      arrowId:
        typeof impact.arrowId === "string" && impact.arrowId.length <= 160
          ? impact.arrowId
          : null,
      projectileId: impact.projectileId,
      networkEventId: impact.networkEventId,
      performanceTimeMs: impact.performanceTimeMs,
      impactPosition,
      travelledMetres: Number.isFinite(impact.travelledMetres)
        ? impact.travelledMetres
        : null,
      flightProgress: Number.isFinite(impact.flightProgress)
        ? impact.flightProgress
        : null,
      damage: impact.damage,
      visualFound: impact.visualFound,
      impactParticleCount: impact.impactParticleCount,
    };
  };
  const normalizeDamage = (event) => {
    if (
      !Number.isSafeInteger(event?.sequence) ||
      event.sequence < 0 ||
      typeof event.projectileId !== "string" ||
      event.projectileId.length === 0 ||
      event.projectileId.length > 160 ||
      !duelPlayerIds.has(event.attackerId) ||
      !duelPlayerIds.has(event.targetId) ||
      !Number.isFinite(event.damage) ||
      event.damage < 0 ||
      !Number.isFinite(event.performanceTimeMs) ||
      typeof event.hitReactionTriggered !== "boolean" ||
      typeof event.damageSplatCreated !== "boolean" ||
      !(
        event.hitReactionTriggerCount === null ||
        (Number.isSafeInteger(event.hitReactionTriggerCount) &&
          event.hitReactionTriggerCount >= 0)
      )
    ) {
      return null;
    }
    return {
      sequence: event.sequence,
      projectileId: event.projectileId,
      attackerId: event.attackerId,
      targetId: event.targetId,
      attackType:
        typeof event.attackType === "string" ? event.attackType : null,
      targetType:
        event.targetType === "player" || event.targetType === "mob"
          ? event.targetType
          : null,
      damage: event.damage,
      isCritical: event.isCritical === true,
      performanceTimeMs: event.performanceTimeMs,
      hitReactionTriggered: event.hitReactionTriggered,
      hitReactionTriggerCount: event.hitReactionTriggerCount,
      damageSplatCreated: event.damageSplatCreated,
    };
  };
  const normalizeCancellation = (event) => {
    if (
      !Number.isSafeInteger(event?.sequence) ||
      event.sequence < 0 ||
      !duelPlayerIds.has(event.attackerId) ||
      !duelPlayerIds.has(event.targetId) ||
      typeof event.projectileId !== "string" ||
      event.projectileId.length === 0 ||
      event.projectileId.length > 160 ||
      typeof event.networkEventId !== "string" ||
      event.networkEventId.length === 0 ||
      event.networkEventId.length > 160 ||
      !Number.isFinite(event.performanceTimeMs) ||
      ![
        "combat_ended",
        "entity_died",
        "player_respawned",
        "player_disconnected",
        "combat_state_missing",
      ].includes(event.reason) ||
      typeof event.visualFound !== "boolean"
    ) {
      return null;
    }
    return {
      sequence: event.sequence,
      launchSequence: Number.isSafeInteger(event.launchSequence)
        ? event.launchSequence
        : null,
      attackerId: event.attackerId,
      targetId: event.targetId,
      arrowId:
        typeof event.arrowId === "string" && event.arrowId.length <= 160
          ? event.arrowId
          : null,
      projectileId: event.projectileId,
      launchNetworkEventId:
        typeof event.launchNetworkEventId === "string" &&
        event.launchNetworkEventId.length > 0 &&
        event.launchNetworkEventId.length <= 160
          ? event.launchNetworkEventId
          : null,
      networkEventId: event.networkEventId,
      performanceTimeMs: event.performanceTimeMs,
      reason: event.reason,
      visualFound: event.visualFound,
    };
  };

  if (!rangedTransitionBaselineInitialized) {
    rangedTransitionBaselineInitialized = true;
    lastBowTransitionSequence = bow.latestSequence;
    lastArrowSpawnSequence = projectiles.latestSequence;
    lastArrowImpactSequence = projectiles.latestImpactSequence;
    lastArrowCancellationSequence = projectiles.latestCancellationSequence;
    lastDamagePresentationSequence = damage.latestSequence;
    rangedTransitionCancelledBeforeSpawnBaseline =
      projectiles.arrowCancelledBeforeSpawnCount;
    rangedTransitionExpiredBeforeImpactBaseline =
      projectiles.arrowExpiredBeforeImpactCount;
  }
  if (
    bow.latestSequence < lastBowTransitionSequence ||
    projectiles.latestSequence < lastArrowSpawnSequence ||
    projectiles.latestImpactSequence < lastArrowImpactSequence ||
    projectiles.latestCancellationSequence < lastArrowCancellationSequence ||
    damage.latestSequence < lastDamagePresentationSequence
  ) {
    lastRangedTransitionDiagnosticRejectionReason = "sequence_regression";
    return null;
  }
  const selectedEvents = selectDuelRangedPresentationEvents({
    duelPlayerIds,
    recentTransitions: bow.recentTransitions,
    recentArrowSpawns: projectiles.recentArrowSpawns,
    recentArrowImpacts: projectiles.recentArrowImpacts,
    recentArrowCancellations: projectiles.recentArrowCancellations,
    recentDamageEvents: damage.recentEvents,
    activeArrows: projectiles.activeArrows,
    lastBowTransitionSequence,
    lastArrowSpawnSequence,
    lastArrowImpactSequence,
    lastArrowCancellationSequence,
    lastDamageSequence: lastDamagePresentationSequence,
  });
  const rawTransitions = selectedEvents.transitions;
  const transitions = rawTransitions.map(normalizeTransition);
  const rawSpawns = selectedEvents.spawnEvents;
  // Do not pass normalizeSpawn directly to Array.map: map's numeric index
  // would become the optional `active` flag and make every batched spawn after
  // the first require active-flight-only fields.
  const spawnEvents = rawSpawns.map((spawn) => normalizeSpawn(spawn));
  const impactEvents = selectedEvents.impactEvents.map(normalizeImpact);
  const cancellationEvents = selectedEvents.cancellationEvents.map(
    normalizeCancellation,
  );
  const damageEvents = selectedEvents.damageEvents
    .filter((event) => typeof event?.projectileId === "string")
    .map(normalizeDamage);
  const activeArrows = selectedEvents.activeArrows.map((spawn) =>
    normalizeSpawn(spawn, true),
  );
  const explainInvalidSpawn = (spawn, active) => {
    if (!Number.isSafeInteger(spawn?.sequence) || spawn.sequence < 0) {
      return "sequence";
    }
    if (!duelPlayerIds.has(spawn.attackerId)) return "attacker";
    if (
      typeof spawn.targetId !== "string" ||
      spawn.targetId.length === 0 ||
      spawn.targetId.length > 160
    ) {
      return "target_id";
    }
    if (
      typeof spawn.projectileId !== "string" ||
      spawn.projectileId.length === 0 ||
      spawn.projectileId.length > 160
    ) {
      return "projectile_id";
    }
    if (!Number.isFinite(spawn.performanceTimeMs)) return "time";
    if (!finitePositionTuple(spawn.startPosition)) return "start_position";
    if (!finitePositionTuple(spawn.targetPosition)) return "target_position";
    if (!active) return "unknown";
    if (!finitePositionTuple(spawn.currentPosition)) {
      return "current_position";
    }
    if (!Number.isFinite(spawn.elapsedMs) || spawn.elapsedMs < 0) {
      return "elapsed";
    }
    if (
      !Number.isFinite(spawn.distanceTraveled) ||
      spawn.distanceTraveled < 0
    ) {
      return "distance";
    }
    if (
      !Number.isFinite(spawn.flightProgress) ||
      spawn.flightProgress < 0 ||
      spawn.flightProgress > 1
    ) {
      return "progress";
    }
    return "unknown";
  };
  const invalidSpawnIndex = spawnEvents.findIndex((spawn) => spawn === null);
  if (invalidSpawnIndex >= 0) {
    lastRangedTransitionDiagnosticRejectionReason = `spawn_invalid_${explainInvalidSpawn(rawSpawns[invalidSpawnIndex], false)}`;
    return null;
  }
  const invalidActiveArrowIndex = activeArrows.findIndex(
    (spawn) => spawn === null,
  );
  if (invalidActiveArrowIndex >= 0) {
    lastRangedTransitionDiagnosticRejectionReason = `active_arrow_invalid_${explainInvalidSpawn(selectedEvents.activeArrows[invalidActiveArrowIndex], true)}`;
    return null;
  }
  const invalidEventGroup = [
    ["transition_invalid", transitions],
    ["impact_invalid", impactEvents],
    ["cancellation_invalid", cancellationEvents],
    ["damage_invalid", damageEvents],
  ].find(([, events]) => events.some((event) => event === null));
  if (invalidEventGroup) {
    lastRangedTransitionDiagnosticRejectionReason = invalidEventGroup[0];
    return null;
  }
  lastBowTransitionSequence = bow.latestSequence;
  lastArrowSpawnSequence = projectiles.latestSequence;
  lastArrowImpactSequence = projectiles.latestImpactSequence;
  lastArrowCancellationSequence = projectiles.latestCancellationSequence;
  lastDamagePresentationSequence = damage.latestSequence;
  return {
    observedAt,
    performanceTimeMs: bow.performanceTimeMs,
    cycleId: normalizedDiagnostics.cycleId,
    rangedPlayerIds,
    players,
    transitions,
    spawnEvents,
    impactEvents,
    cancellationEvents,
    damageEvents,
    activeArrows,
    arrowCancelledBeforeSpawnCount: projectiles.arrowCancelledBeforeSpawnCount,
    arrowCancelledBeforeSpawnDelta:
      projectiles.arrowCancelledBeforeSpawnCount -
      rangedTransitionCancelledBeforeSpawnBaseline,
    arrowExpiredBeforeImpactCount: projectiles.arrowExpiredBeforeImpactCount,
    arrowExpiredBeforeImpactDelta:
      projectiles.arrowExpiredBeforeImpactCount -
      rangedTransitionExpiredBeforeImpactBaseline,
  };
}

const multiStyle = options["multi-style"] === true;
const requireHitReactions = options["require-hit-reactions"] === true;
const requireRangedTransitions = options["require-ranged-transitions"] === true;
const expectedRoles = parseDuelMotionRoles(options.roles, multiStyle);
const networkLatencyMs = parseBoundedInteger(
  options["network-latency-ms"],
  0,
  0,
  2_000,
  "network-latency-ms",
);
const cpuThrottleRate = parseBoundedNumber(
  options["cpu-throttle-rate"],
  1,
  1,
  20,
  "cpu-throttle-rate",
);
if (requireRangedTransitions && !expectedRoles.includes("ranged")) {
  throw new TypeError(
    "require-ranged-transitions needs at least one ranged role",
  );
}
if (
  requireRangedTransitions &&
  (networkLatencyMs < 100 || cpuThrottleRate < 2)
) {
  throw new RangeError(
    "require-ranged-transitions needs at least 100 ms browser latency and 2x CPU throttling",
  );
}
const rawStreamUrl = parseHttpUrl(options["stream-url"], "stream-url");
const streamUrl = new URL(
  applyCaptureFrameRateToUrl(rawStreamUrl.toString(), 60),
);
const streamingViewerToken = String(
  process.env.STREAMING_CAPTURE_VIEWER_TOKEN ?? "",
).trim();
const streamNavigationUrl = attachStreamingViewerToken(
  streamUrl,
  streamingViewerToken,
);
const stateUrl = parseHttpUrl(options["state-url"], "state-url");
const explicitStateBearerToken = String(
  process.env.STREAMING_CAPTURE_STATE_TOKEN ?? "",
).trim();
const stateBearerToken = explicitStateBearerToken || streamingViewerToken;
const stateAuthorizationMode = explicitStateBearerToken
  ? "explicit_state_token"
  : streamingViewerToken
    ? "viewer_token_fallback"
    : "public";
const outputDirectory = path.resolve(String(options["output-dir"]));
const manifestPath = path.join(outputDirectory, "manifest.json");
const screenshotPath = path.join(outputDirectory, "fighting-motion.png");
// A failed performance budget is itself useful evidence and must not prevent
// the verifier from retaining the exact visual frame that accompanied it.
// Performance checks remain fatal in the final manifest; they are only
// independent from screenshot eligibility.
const SCREENSHOT_INDEPENDENT_PERFORMANCE_CHECKS = new Set([
  "60 FPS cadence meets percentile budget",
  "render work meets frame budget",
  "slow-frame ratio remains bounded",
]);
const durationSeconds = parseBoundedInteger(
  options["duration-s"],
  240,
  15,
  3_600,
  "duration-s",
);
const minimumFightingSeconds = parseBoundedInteger(
  options["minimum-fighting-s"],
  requireRangedTransitions ? 60 : 0,
  0,
  3_600,
  "minimum-fighting-s",
);
const maximumDurationSeconds = parseBoundedInteger(
  options["maximum-duration-s"],
  Math.max(durationSeconds, minimumFightingSeconds * 4),
  durationSeconds,
  7_200,
  "maximum-duration-s",
);
const durationMs = durationSeconds * 1_000;
const minimumFightingObservationMs = minimumFightingSeconds * 1_000;
const maximumDurationMs = maximumDurationSeconds * 1_000;
const startupTimeoutSeconds = parseBoundedInteger(
  options["startup-timeout-s"],
  180,
  30,
  900,
  "startup-timeout-s",
);
const startupTimeoutMs = startupTimeoutSeconds * 1_000;
const pollMs = parseBoundedInteger(
  options["poll-ms"],
  100,
  50,
  1_000,
  "poll-ms",
);
const viewport = parseViewport(options.viewport);
const safeCrop = parseDuelMotionSafeCrop(
  options["safe-ndc-x"],
  options["safe-ndc-y"],
);

await access(manifestPath)
  .then(() => {
    throw new Error(`refusing to overwrite existing evidence: ${manifestPath}`);
  })
  .catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);

const captureHeadless = options.headed !== true;
const captureAngleBackend =
  String(process.env.STREAMING_CAPTURE_ANGLE ?? "").trim() ||
  (process.platform === "darwin" ? "metal" : "vulkan");
const captureBrowserChannel =
  String(process.env.STREAMING_CAPTURE_BROWSER_CHANNEL ?? "").trim() ||
  (process.platform === "darwin" ? "chrome" : undefined);
const browser = await chromium.launch({
  headless: captureHeadless,
  args: buildDefaultCaptureLaunchArgs({
    angleBackend: captureAngleBackend,
    featureFlags: resolveDefaultCaptureFeatureFlags(process.platform),
  }),
  ...(captureBrowserChannel ? { channel: captureBrowserChannel } : {}),
});
// A release gate must exercise the artifacts served by this exact stack run,
// never a PWA service-worker response retained from an earlier local build.
const context = await browser.newContext({
  viewport,
  serviceWorkers: "block",
});
const page = await context.newPage();
const cdpSession = await context.newCDPSession(page);
let browserConditionError = null;
try {
  await cdpSession.send("Network.enable");
  await cdpSession.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (networkLatencyMs > 0) {
    await cdpSession.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: networkLatencyMs,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });
  }
} catch (error) {
  browserConditionError = boundedMessage(
    error instanceof Error ? error.message : String(error),
  );
}
const consoleErrors = [];
const requestFailures = [];
const responseFailures = [];
const runtimeErrors = [];
const preEvidenceRuntimeErrors = [];
const rejectionCounts = new Map();
const preEvidenceRejectionCounts = new Map();
const integrityRejectionCounts = new Map();
const phaseObservationCounts = new Map();
const samples = [];
const hitReactionLifecycleSamples = [];
const rangedTransitionSnapshots = [];
let rangedTransitionBaselineInitialized = false;
let lastRangedTransitionDiagnosticRejectionReason = null;
let lastBowTransitionSequence = 0;
let lastArrowSpawnSequence = 0;
let lastArrowImpactSequence = 0;
let lastArrowCancellationSequence = 0;
let lastDamagePresentationSequence = 0;
let rangedTransitionCancelledBeforeSpawnBaseline = 0;
let rangedTransitionExpiredBeforeImpactBaseline = 0;
let latestPerformance = null;
let latestCoreSummarySatisfied = false;
let sceneComplexity = null;
let lastSceneUpdatedAt = null;
let lastLifecycleSceneUpdatedAt = null;
let screenshot = null;
const screenshotAttempts = [];
let screenshotAttemptCount = 0;
let navigationError = null;
let lastProgressAt = 0;
let maximumUiStyleSwitchEvents = 0;
let uiStyleSwitchBaseline = 0;
let latestEquipmentReadiness = null;
let fightingObservation = { totalMs: 0, previous: null };
const startedAt = Date.now();
let measurementStartedAt = null;

const recordRejection = (reason) => {
  increment(rejectionCounts, reason);
  if (!isDuelMotionSamplingRace(reason)) {
    increment(integrityRejectionCounts, reason);
  }
};

const specializedEvidenceIsSatisfied = () => {
  const styleChecks = multiStyle
    ? evaluateDuelStyleSwitchTelemetry(
        summarizeDuelStyleSwitchTelemetry(samples, maximumUiStyleSwitchEvents),
        expectedRoles,
      )
    : [];
  const hitReactionSatisfied = requireHitReactions
    ? summarizeDuelHitReactionTelemetry(samples).ok &&
      summarizeDuelHitReactionResolutionTelemetry(
        samples,
        hitReactionLifecycleSamples,
      ).ok
    : true;
  const rangedSatisfied = requireRangedTransitions
    ? summarizeDuelRangedTransitionTelemetry(rangedTransitionSnapshots).ok
    : true;
  return (
    styleChecks.every((entry) => entry.pass) &&
    hitReactionSatisfied &&
    rangedSatisfied
  );
};

page.on("console", (message) => {
  if (
    message.type() !== "error" ||
    consoleErrors.length >= MAX_RETAINED_ERRORS
  ) {
    return;
  }
  consoleErrors.push({
    at: Date.now(),
    message: boundedMessage(message.text()),
  });
});
page.on("pageerror", (error) => {
  if (consoleErrors.length >= MAX_RETAINED_ERRORS) return;
  consoleErrors.push({
    at: Date.now(),
    message: boundedMessage(error.message),
  });
});
page.on("requestfailed", (request) => {
  if (requestFailures.length >= MAX_RETAINED_ERRORS) return;
  requestFailures.push({
    at: Date.now(),
    method: request.method(),
    url: redactRequestUrl(request.url()),
    reason: boundedMessage(
      request.failure()?.errorText ?? "request failed",
      200,
    ),
  });
});
page.on("response", (response) => {
  if (
    response.status() < 400 ||
    responseFailures.length >= MAX_RETAINED_ERRORS
  ) {
    return;
  }
  responseFailures.push({
    at: Date.now(),
    method: response.request().method(),
    status: response.status(),
    url: redactRequestUrl(response.url()),
  });
});

try {
  await page.goto(streamNavigationUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.waitForSelector("canvas", {
    state: "attached",
    timeout: 120_000,
  });

  while (
    (measurementStartedAt === null
      ? Date.now() - startedAt < startupTimeoutMs
      : Date.now() - measurementStartedAt < maximumDurationMs) &&
    (measurementStartedAt === null ||
      Date.now() - measurementStartedAt < durationMs ||
      fightingObservation.totalMs < minimumFightingObservationMs ||
      !specializedEvidenceIsSatisfied() ||
      !latestCoreSummarySatisfied ||
      screenshot === null)
  ) {
    const observedAt = Date.now();
    let browserProbe;
    let serverState;
    try {
      [browserProbe, serverState] = await Promise.all([
        readBrowserProbe(page),
        fetchState(stateUrl, stateBearerToken),
      ]);
    } catch (error) {
      const targetErrors =
        samples.length > 0 ? runtimeErrors : preEvidenceRuntimeErrors;
      if (targetErrors.length < MAX_RETAINED_ERRORS) {
        targetErrors.push({
          at: observedAt,
          message: boundedMessage(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    latestPerformance = browserProbe.performance ?? latestPerformance;
    const currentUiStyleSwitchEvents =
      Number(browserProbe.layout.styleSwitchEventCount) || 0;
    if (measurementStartedAt !== null) {
      maximumUiStyleSwitchEvents = Math.max(
        maximumUiStyleSwitchEvents,
        Math.max(0, currentUiStyleSwitchEvents - uiStyleSwitchBaseline),
      );
    }
    const normalizedState = normalizeDuelCaptureState(browserProbe.state);
    increment(phaseObservationCounts, normalizedState?.phase ?? "INVALID");
    if (
      !normalizedState ||
      !["FIGHTING", "RESOLUTION"].includes(normalizedState.phase)
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const reject = (reason) => {
      if (samples.length > 0) {
        recordRejection(reason);
      } else {
        increment(preEvidenceRejectionCounts, reason);
      }
    };
    if (!duelCaptureStatesAgree(browserProbe.state, serverState)) {
      reject("browser_server_state_disagreement");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    const baseLayoutReady =
      browserProbe.layout.canvasCount === 1 &&
      browserProbe.layout.errorOverlayCount === 0 &&
      browserProbe.layout.scrollWidth <= browserProbe.layout.innerWidth &&
      browserProbe.layout.scrollHeight <= browserProbe.layout.innerHeight;
    if (browserProbe.rendererHealth?.ready !== true || !baseLayoutReady) {
      reject("renderer_or_layout_not_ready");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    const sceneEvaluation = evaluateDuelSceneCapture(
      browserProbe.sceneDiagnostics,
      browserProbe.state,
      observedAt,
    );
    const blockingSceneIssues = sceneEvaluation.issues.filter(
      (issue) =>
        issue !== "agent1_combat_facing_error" &&
        issue !== "agent2_combat_facing_error",
    );
    if (!sceneEvaluation.diagnostics || blockingSceneIssues.length > 0) {
      for (const issue of blockingSceneIssues.length > 0
        ? blockingSceneIssues
        : ["scene_invalid"]) {
        reject(`scene:${issue}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (sceneEvaluation.diagnostics.updatedAt !== lastLifecycleSceneUpdatedAt) {
      const lifecycleSample = buildHitReactionLifecycleSample(
        normalizedState,
        sceneEvaluation.diagnostics,
        observedAt,
      );
      if (lifecycleSample) {
        lastLifecycleSceneUpdatedAt = lifecycleSample.sceneUpdatedAt;
        hitReactionLifecycleSamples.push(lifecycleSample);
        if (hitReactionLifecycleSamples.length > MAX_RETAINED_SAMPLES) {
          hitReactionLifecycleSamples.shift();
        }
      }
    }
    if (normalizedState.phase !== "FIGHTING") {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    const publicAgents = [
      browserProbe.state?.cycle?.agent1,
      browserProbe.state?.cycle?.agent2,
    ];
    if (!publicRoleStateMatches(publicAgents, expectedRoles, multiStyle)) {
      reject("combat_role_mismatch");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    latestEquipmentReadiness = browserProbe.equipmentReadiness;
    if (
      !hasExactVisibleFightingEquipment(
        latestEquipmentReadiness,
        normalizedState.cycleId,
      )
    ) {
      reject("active_equipment_not_visible");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    const fightingLayoutReady =
      browserProbe.layout.activeHudCount === 1 &&
      (!multiStyle ||
        (browserProbe.layout.activeCombatRoles.length === 2 &&
          browserProbe.layout.activeCombatRoles.every((role) =>
            COMBAT_ROLES.has(role),
          )));
    if (!fightingLayoutReady) {
      reject("renderer_or_layout_not_ready");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (measurementStartedAt === null) {
      try {
        if (cpuThrottleRate > 1) {
          await cdpSession.send("Emulation.setCPUThrottlingRate", {
            rate: cpuThrottleRate,
          });
        }
        const telemetryReset = await page.evaluate(() =>
          typeof window.__HYPERIA_RESET_STREAM_PERFORMANCE__ === "function"
            ? window.__HYPERIA_RESET_STREAM_PERFORMANCE__()
            : false,
        );
        if (!telemetryReset) {
          throw new Error("stream performance reset hook unavailable");
        }
      } catch (error) {
        browserConditionError = boundedMessage(
          error instanceof Error ? error.message : String(error),
        );
        break;
      }
      measurementStartedAt = Date.now();
      uiStyleSwitchBaseline = currentUiStyleSwitchEvents;
      maximumUiStyleSwitchEvents = 0;
      latestPerformance = null;
      lastProgressAt = measurementStartedAt;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (sceneEvaluation.diagnostics.updatedAt === lastSceneUpdatedAt) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    const sample = buildMotionSample(
      browserProbe.state,
      sceneEvaluation.diagnostics,
      observedAt,
      multiStyle,
    );
    if (!sample) {
      reject("sample_invalid");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    lastSceneUpdatedAt = sample.sceneUpdatedAt;
    fightingObservation = accumulateFightingObservation(
      fightingObservation,
      sample,
    );
    samples.push(sample);
    if (samples.length > MAX_RETAINED_SAMPLES) samples.shift();
    if (requireRangedTransitions) {
      const transitionSnapshot = buildRangedTransitionSnapshot(
        browserProbe.sceneDiagnostics,
        sceneEvaluation.diagnostics,
        sample.agents.map((agent) => agent.role),
        observedAt,
      );
      if (!transitionSnapshot) {
        reject(
          `ranged_transition_diagnostics_invalid:${lastRangedTransitionDiagnosticRejectionReason ?? "unknown"}`,
        );
      } else {
        rangedTransitionSnapshots.push(transitionSnapshot);
        if (rangedTransitionSnapshots.length > MAX_RETAINED_SAMPLES) {
          rangedTransitionSnapshots.shift();
        }
      }
    }

    const summary = summarizeDuelMotionTelemetry({
      samples,
      performance: latestPerformance,
      expectedRoles,
      safeCrop,
    });
    latestCoreSummarySatisfied = summary.ok;
    const liveStyleMetrics = summarizeDuelStyleSwitchTelemetry(
      samples,
      maximumUiStyleSwitchEvents,
    );
    const liveHitReactionSummary = summarizeDuelHitReactionTelemetry(samples);
    const liveHitReactionResolutionSummary =
      summarizeDuelHitReactionResolutionTelemetry(
        samples,
        hitReactionLifecycleSamples,
      );
    const liveRangedTransitionSummary = requireRangedTransitions
      ? summarizeDuelRangedTransitionTelemetry(rangedTransitionSnapshots)
      : null;
    const liveStyleChecks = multiStyle
      ? evaluateDuelStyleSwitchTelemetry(liveStyleMetrics, expectedRoles)
      : [];
    if (options.verbose && observedAt - lastProgressAt >= 5_000) {
      lastProgressAt = observedAt;
      console.log(
        JSON.stringify({
          samples: summary.metrics.sampleCount,
          observationMs: summary.metrics.observationMs,
          cumulativeFightingObservationMs: fightingObservation.totalMs,
          roles: summary.metrics.observedRoles,
          agents: summary.metrics.agents.map((agent) => ({
            role: agent.role,
            travelXZ: agent.travelXZ,
            diagonalSegments: agent.diagonalSegments,
            facingP95: agent.facingErrorDegrees.p95,
            yawDeltaP95: agent.yawDeltaDegrees.p95,
          })),
          frameP95: summary.metrics.performance.frameIntervalMs?.p95 ?? null,
          styleSwitches: liveStyleMetrics.totalSwitches,
          hitReactionTriggers: liveHitReactionSummary.metrics.triggerIncrements,
          rangedTransitions:
            liveRangedTransitionSummary?.metrics.agents.map((agent) => ({
              playerId: agent.playerId,
              released: agent.releasedCount,
              spawned: agent.spawnedCount,
              paired: agent.pairedCount,
              completedFlights: agent.completedFlightCount,
              impacts: agent.impactCount,
              impactPresentations: agent.impactPresentationPassCount,
            })) ?? [],
          failingChecks: [
            ...summary.checks,
            ...liveStyleChecks,
            ...(requireHitReactions
              ? [
                  ...liveHitReactionSummary.checks,
                  ...liveHitReactionResolutionSummary.checks,
                ]
              : []),
            ...(liveRangedTransitionSummary?.checks ?? []),
          ]
            .filter((entry) => !entry.pass)
            .map((entry) => entry.label),
        }),
      );
    }

    if (
      screenshot === null &&
      summary.checks.every(
        (entry) =>
          entry.pass ||
          SCREENSHOT_INDEPENDENT_PERFORMANCE_CHECKS.has(entry.label),
      ) &&
      liveStyleChecks.every((entry) => entry.pass) &&
      (!requireHitReactions ||
        (liveHitReactionSummary.ok && liveHitReactionResolutionSummary.ok)) &&
      (!requireRangedTransitions || liveRangedTransitionSummary?.ok === true) &&
      integrityRejectionCounts.size === 0 &&
      runtimeErrors.length === 0 &&
      consoleErrors.length === 0 &&
      requestFailures.length === 0 &&
      responseFailures.length === 0
    ) {
      const attempt = {
        attempt: ++screenshotAttemptCount,
        status: "pending",
        captureRequestedAt: null,
        captureCompletedAt: null,
        sceneAdmittedAt: null,
        beforeClock: null,
        immediateAfterClock: null,
        afterSnapshotClock: null,
        beforePerformance: null,
        immediateAfterPerformance: null,
        afterPerformance: null,
        snapshotFreshness: null,
        error: null,
      };
      screenshotAttempts.push(attempt);
      if (screenshotAttempts.length > MAX_RETAINED_SCREENSHOT_ATTEMPTS) {
        screenshotAttempts.shift();
      }
      try {
        const beforeProbe = await readScreenshotPerformanceProbe(
          page,
          SCREENSHOT_PERFORMANCE_TIMEOUT_MS,
        );
        attempt.beforeClock = beforeProbe.clock;
        attempt.beforePerformance = cloneDuelScreenshotPerformanceSnapshot(
          beforeProbe.performance,
        );
        attempt.captureRequestedAt = Date.now();
        await page.screenshot({ path: screenshotPath });
        attempt.captureCompletedAt = Date.now();
        await chmod(screenshotPath, 0o600);
        const [afterBrowserProbe, afterServerState] = await Promise.all([
          readBrowserProbe(page),
          fetchState(stateUrl, stateBearerToken),
        ]);
        const afterState = normalizeDuelCaptureState(afterBrowserProbe.state);
        attempt.immediateAfterClock = afterBrowserProbe.clock;
        attempt.immediateAfterPerformance =
          cloneDuelScreenshotPerformanceSnapshot(afterBrowserProbe.performance);
        const afterAgents = [
          afterBrowserProbe.state?.cycle?.agent1,
          afterBrowserProbe.state?.cycle?.agent2,
        ];
        if (
          afterState?.phase !== "FIGHTING" ||
          !duelCaptureStatesAgree(afterBrowserProbe.state, afterServerState) ||
          !publicRoleStateMatches(afterAgents, expectedRoles, multiStyle) ||
          !hasExactVisibleFightingEquipment(
            afterBrowserProbe.equipmentReadiness,
            afterState?.cycleId,
          ) ||
          afterBrowserProbe.rendererHealth?.ready !== true ||
          afterBrowserProbe.layout.errorOverlayCount !== 0
        ) {
          await unlink(screenshotPath).catch(() => {});
          recordRejection("post_screenshot_state_invalid");
          attempt.status = "scene_rejected";
        } else {
          latestPerformance =
            afterBrowserProbe.performance ?? latestPerformance;
          screenshot = {
            file: path.basename(screenshotPath),
            sha256: await sha256(screenshotPath),
            capturedAt: Date.now(),
            cycleId: afterState.cycleId,
            viewport,
          };
          attempt.sceneAdmittedAt = screenshot.capturedAt;
          latestPerformance = await waitForScreenshotPerformance(
            page,
            attempt,
            afterBrowserProbe,
          );
          attempt.status = "complete";
        }
      } catch (error) {
        attempt.status = "failed";
        attempt.error = boundedMessage(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} catch (error) {
  navigationError = boundedMessage(
    error instanceof Error ? error.message : String(error),
  );
} finally {
  sceneComplexity = await page
    .evaluate(() =>
      typeof window.__HYPERIA_GET_STREAM_SCENE_COMPLEXITY__ === "function"
        ? window.__HYPERIA_GET_STREAM_SCENE_COMPLEXITY__()
        : null,
    )
    .catch(() => null);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

const motionSummary = summarizeDuelMotionTelemetry({
  samples,
  performance: latestPerformance,
  expectedRoles,
  safeCrop,
});
const styleSwitchMetrics = summarizeDuelStyleSwitchTelemetry(
  samples,
  maximumUiStyleSwitchEvents,
);
const finalStyleSwitchChecks = multiStyle
  ? evaluateDuelStyleSwitchTelemetry(styleSwitchMetrics, expectedRoles)
  : [];
const hitReactionSummary = summarizeDuelHitReactionTelemetry(samples);
const hitReactionResolutionSummary =
  summarizeDuelHitReactionResolutionTelemetry(
    samples,
    hitReactionLifecycleSamples,
  );
const rangedTransitionSummary = requireRangedTransitions
  ? summarizeDuelRangedTransitionTelemetry(rangedTransitionSnapshots)
  : null;
const finalScreenshotAttempt = screenshotAttempts.at(-1) ?? null;
const captureChecks = [
  ...motionSummary.checks,
  ...finalStyleSwitchChecks,
  ...(requireHitReactions
    ? [...hitReactionSummary.checks, ...hitReactionResolutionSummary.checks]
    : []),
  ...(rangedTransitionSummary?.checks ?? []),
  {
    label: "required cumulative FIGHTING observation is retained",
    pass: fightingObservation.totalMs >= minimumFightingObservationMs,
    actual: `acceptedMs=${fightingObservation.totalMs},requiredMs=${minimumFightingObservationMs}`,
  },
  {
    label: "requested browser network and CPU conditions are active",
    pass: browserConditionError === null,
    actual: browserConditionError
      ? `error=${browserConditionError}`
      : `latencyMs=${networkLatencyMs},cpuRate=${cpuThrottleRate}`,
  },
  {
    label: "stream requested at true 60 FPS",
    pass: streamUrl.searchParams.get("streamFps") === "60",
    actual: streamUrl.searchParams.get("streamFps") ?? "missing",
  },
  {
    label: "stream requested with the canonical versioned render profile",
    pass:
      streamUrl.searchParams.get("streamRenderProfile") ===
      CANONICAL_CAPTURE_RENDER_PROFILE,
    actual: streamUrl.searchParams.get("streamRenderProfile") ?? "missing",
  },
  {
    label: "motion screenshot retained",
    pass: screenshot !== null,
    actual: screenshot?.file ?? "missing",
  },
  {
    label: "screenshot performance advances in the same session past capture",
    pass:
      screenshot !== null &&
      finalScreenshotAttempt?.status === "complete" &&
      finalScreenshotAttempt.snapshotFreshness?.status === "ready" &&
      finalScreenshotAttempt.sceneAdmittedAt === screenshot.capturedAt &&
      latestPerformance?.sessionStartedAt ===
        finalScreenshotAttempt.afterPerformance?.sessionStartedAt &&
      latestPerformance.updatedAt >=
        finalScreenshotAttempt.afterPerformance.updatedAt &&
      latestPerformance.overall.frames >=
        finalScreenshotAttempt.afterPerformance.overall.frames,
    actual:
      finalScreenshotAttempt?.error ??
      finalScreenshotAttempt?.snapshotFreshness?.reason ??
      finalScreenshotAttempt?.status ??
      "missing",
  },
  {
    label: "continuous samples have no integrity rejection",
    pass: integrityRejectionCounts.size === 0,
    actual:
      integrityRejectionCounts.size === 0
        ? "0"
        : JSON.stringify(Object.fromEntries(integrityRejectionCounts)),
  },
  {
    label: "browser and state probes complete without errors",
    pass:
      navigationError === null &&
      preEvidenceRuntimeErrors.length === 0 &&
      runtimeErrors.length === 0 &&
      consoleErrors.length === 0 &&
      requestFailures.length === 0 &&
      responseFailures.length === 0,
    actual: `navigation=${navigationError ? 1 : 0},preEvidenceRuntime=${preEvidenceRuntimeErrors.length},runtime=${runtimeErrors.length},console=${consoleErrors.length},requests=${requestFailures.length},responses=${responseFailures.length}`,
  },
];
const finishedAt = Date.now();
const ok = captureChecks.every((entry) => entry.pass);
const manifest = {
  schemaVersion: 8,
  ok,
  startedAt,
  finishedAt,
  elapsedMs: finishedAt - startedAt,
  startupTimeoutMs,
  measurementStartedAt,
  measurementElapsedMs:
    measurementStartedAt === null ? 0 : finishedAt - measurementStartedAt,
  minimumDurationMs: durationMs,
  maximumDurationMs,
  minimumFightingObservationMs,
  cumulativeFightingObservationMs: fightingObservation.totalMs,
  streamUrl: publicUrl(streamUrl),
  stateUrl: publicUrl(stateUrl),
  stateAuthorizationMode,
  requestedFrameRate: 60,
  multiStyle,
  requireHitReactions,
  requireRangedTransitions,
  expectedRoles,
  equipmentReadiness: latestEquipmentReadiness,
  captureBrowser: {
    headless: captureHeadless,
    channel: captureBrowserChannel ?? "bundled",
    angleBackend: captureAngleBackend,
    networkLatencyMs,
    cpuThrottleRate,
    conditionError: browserConditionError,
  },
  viewport,
  safeCropNdc: safeCrop,
  limits: DUEL_MOTION_TELEMETRY_LIMITS,
  screenshot,
  screenshotPerformanceDiagnostics: {
    causality: "unattributed",
    maximumRetainedAttempts: MAX_RETAINED_SCREENSHOT_ATTEMPTS,
    maximumSnapshotCharacters: 262_144,
    freshnessTimeoutMs: SCREENSHOT_PERFORMANCE_TIMEOUT_MS,
    totalAttempts: screenshotAttemptCount,
    omittedAttempts: screenshotAttemptCount - screenshotAttempts.length,
    attempts: screenshotAttempts,
  },
  checks: captureChecks,
  metrics: motionSummary.metrics,
  sceneComplexity,
  styleSwitchMetrics,
  hitReactionMetrics: hitReactionSummary.metrics,
  hitReactionResolutionMetrics: hitReactionResolutionSummary.metrics,
  rangedTransitionMetrics: rangedTransitionSummary?.metrics ?? null,
  samples,
  hitReactionLifecycleSamples,
  rangedTransitionSnapshots,
  navigationError,
  runtimeErrors,
  preEvidenceRuntimeErrors,
  consoleErrors,
  requestFailures,
  responseFailures,
  rejectionCounts: Object.fromEntries(rejectionCounts),
  preEvidenceRejectionCounts: Object.fromEntries(preEvidenceRejectionCounts),
  integrityRejectionCounts: Object.fromEntries(integrityRejectionCounts),
  phaseObservationCounts: Object.fromEntries(phaseObservationCounts),
};
const temporaryManifestPath = `${manifestPath}.tmp-${process.pid}`;
try {
  await writeFile(
    temporaryManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryManifestPath, manifestPath);
} catch (error) {
  await unlink(temporaryManifestPath).catch(() => {});
  throw error;
}

console.log(
  JSON.stringify({
    ok,
    samples: samples.length,
    observationMs: motionSummary.metrics.observationMs,
    cumulativeFightingObservationMs: fightingObservation.totalMs,
    roles: motionSummary.metrics.observedRoles,
    styleSwitches: styleSwitchMetrics.totalSwitches,
    hitReactionTriggers: hitReactionSummary.metrics.triggerIncrements,
    rangedTransitions:
      rangedTransitionSummary?.metrics.agents.map((agent) => ({
        playerId: agent.playerId,
        released: agent.releasedCount,
        spawned: agent.spawnedCount,
        paired: agent.pairedCount,
        completedFlights: agent.completedFlightCount,
        impacts: agent.impactCount,
        impactPresentations: agent.impactPresentationPassCount,
        maximumNockToSpawnMetres: agent.lastVisibleNockToSpawnMetres.max,
      })) ?? [],
    failingChecks: captureChecks
      .filter((entry) => !entry.pass)
      .map((entry) => entry.label),
    rejectionCounts: Object.fromEntries(rejectionCounts),
    preEvidenceRejectionCounts: Object.fromEntries(preEvidenceRejectionCounts),
    integrityRejectionCounts: Object.fromEntries(integrityRejectionCounts),
    phaseObservationCounts: Object.fromEntries(phaseObservationCounts),
    preEvidenceRuntimeErrors: preEvidenceRuntimeErrors.length,
    consoleErrors: consoleErrors.length,
    requestFailures: requestFailures.length,
    responseFailures: responseFailures.length,
    runtimeErrors: runtimeErrors.length,
    screenshot: screenshot?.file ?? null,
    manifestPath,
  }),
);
if (!ok) process.exitCode = 1;
