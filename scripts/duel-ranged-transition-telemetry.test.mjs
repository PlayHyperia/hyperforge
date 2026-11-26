import { describe, expect, test } from "vitest";

import {
  selectDuelRangedPresentationEvents,
  summarizeDuelRangedTransitionTelemetry,
} from "./duel-ranged-transition-telemetry.mjs";

function snapshots({
  gap = 0,
  controllerReady = true,
  bowItemId = "shortbow",
} = {}) {
  const release = (sequence, playerId, at, x, networkEventId) => ({
    sequence,
    playerId,
    itemId: bowItemId,
    kind: "released",
    performanceTimeMs: at,
    lastVisibleNockWorldPosition: [x, 1.2, 0],
    drawHandWorldPosition: [x, 1.2, 0],
    networkEventId,
  });
  const scheduled = (sequence, playerId, at, networkEventId) => ({
    sequence,
    playerId,
    itemId: bowItemId,
    kind: "scheduled",
    performanceTimeMs: at,
    releaseAtPerformanceTimeMs: at + 400,
    networkEventId,
  });
  const spawn = (sequence, attackerId, at, x, networkEventId) => ({
    sequence,
    attackerId,
    targetId: attackerId === "ranger-a" ? "ranger-b" : "ranger-a",
    arrowId: "bronze_arrow",
    projectileId: `projectile-${sequence}`,
    performanceTimeMs: at,
    startPosition: [x + gap, 1.2, 0],
    targetPosition: [attackerId === "ranger-a" ? 4 : 0, 1.2, 0],
    travelDurationMs: 600,
    networkEventId,
  });
  const active = (event, progress) => ({
    ...event,
    currentPosition: [
      event.startPosition[0] +
        (event.targetPosition[0] - event.startPosition[0]) * progress,
      1.2,
      0,
    ],
    elapsedMs: event.travelDurationMs * progress,
    distanceTraveled:
      Math.abs(event.targetPosition[0] - event.startPosition[0]) * progress,
    flightProgress: progress,
  });
  const impact = (sequence, event) => ({
    sequence,
    launchSequence: event.sequence,
    attackerId: event.attackerId,
    targetId: event.targetId,
    arrowId: event.arrowId,
    projectileId: event.projectileId,
    networkEventId: `server-a:impact-${sequence}`,
    performanceTimeMs: event.performanceTimeMs + 600,
    impactPosition: event.targetPosition,
    travelledMetres: Math.abs(event.targetPosition[0] - event.startPosition[0]),
    flightProgress: 1,
    damage: 7,
    visualFound: true,
    impactParticleCount: 7,
  });
  const damage = (sequence, event) => ({
    sequence,
    projectileId: event.projectileId,
    attackerId: event.attackerId,
    targetId: event.targetId,
    attackType: "ranged",
    targetType: "player",
    damage: 7,
    isCritical: false,
    performanceTimeMs: event.performanceTimeMs + 595,
    hitReactionTriggered: true,
    hitReactionTriggerCount: sequence,
    damageSplatCreated: true,
  });
  const players = ["ranger-a", "ranger-b"].map((playerId) => ({
    playerId,
    role: "ranged",
    itemId: bowItemId,
    controllerReady,
    nockedArrowVisible: true,
    nockedArrowWorldPosition: [0, 1.2, 0],
  }));
  const firstSpawns = [
    spawn(1, "ranger-a", 502, 0, "server-a:launch-1"),
    spawn(2, "ranger-b", 512, 4, "server-a:launch-2"),
  ];
  const secondSpawns = [
    spawn(3, "ranger-a", 1_403, 0.05, "server-a:launch-3"),
    spawn(4, "ranger-b", 1_413, 3.95, "server-a:launch-4"),
  ];
  const base = {
    rangedPlayerIds: ["ranger-a", "ranger-b"],
    players,
    arrowCancelledBeforeSpawnCount: 0,
    arrowCancelledBeforeSpawnDelta: 0,
    arrowExpiredBeforeImpactCount: 0,
    arrowExpiredBeforeImpactDelta: 0,
  };
  return [
    {
      ...base,
      observedAt: 1,
      transitions: [
        scheduled(1, "ranger-a", 100, "server-a:launch-1"),
        release(2, "ranger-a", 500, 0, "server-a:launch-1"),
        scheduled(3, "ranger-b", 110, "server-a:launch-2"),
        release(4, "ranger-b", 510, 4, "server-a:launch-2"),
      ],
      spawnEvents: firstSpawns,
      impactEvents: [],
      damageEvents: [],
      activeArrows: firstSpawns.map((event) => active(event, 0.1)),
    },
    {
      ...base,
      observedAt: 2,
      players: players.map((player) => ({
        ...player,
        nockedArrowVisible: false,
      })),
      transitions: [
        scheduled(5, "ranger-a", 1_000, "server-a:launch-3"),
        release(6, "ranger-a", 1_400, 0.05, "server-a:launch-3"),
        scheduled(7, "ranger-b", 1_010, "server-a:launch-4"),
        release(8, "ranger-b", 1_410, 3.95, "server-a:launch-4"),
      ],
      spawnEvents: secondSpawns,
      impactEvents: firstSpawns.map((event, index) => impact(index + 1, event)),
      damageEvents: firstSpawns.map((event, index) => damage(index + 1, event)),
      activeArrows: [
        ...firstSpawns.map((event) => active(event, 0.65)),
        ...secondSpawns.map((event) => active(event, 0.1)),
      ],
    },
    {
      ...base,
      observedAt: 3,
      players: players.map((player) => ({
        ...player,
        nockedArrowVisible: false,
      })),
      transitions: [],
      spawnEvents: [],
      impactEvents: [],
      damageEvents: [],
      activeArrows: secondSpawns.map((event) => active(event, 0.65)),
    },
    {
      ...base,
      observedAt: 4,
      players: players.map((player) => ({
        ...player,
        nockedArrowVisible: false,
      })),
      transitions: [],
      spawnEvents: [],
      impactEvents: secondSpawns.map((event, index) =>
        impact(index + 3, event),
      ),
      damageEvents: secondSpawns.map((event, index) =>
        damage(index + 3, event),
      ),
      activeArrows: [],
    },
  ];
}

describe("duel ranged transition telemetry", () => {
  test("retains a former ranger's handoff after an atomic role switch", () => {
    const selected = selectDuelRangedPresentationEvents({
      duelPlayerIds: ["agent-a", "agent-b"],
      recentTransitions: [
        { sequence: 4, playerId: "agent-a" },
        { sequence: 5, playerId: "agent-b" },
        { sequence: 6, playerId: "outside" },
      ],
      recentArrowSpawns: [
        { sequence: 8, attackerId: "agent-a" },
        { sequence: 9, attackerId: "outside" },
      ],
      recentArrowCancellations: [
        { sequence: 10, attackerId: "agent-b" },
        { sequence: 11, attackerId: "outside" },
      ],
      activeArrows: [
        { sequence: 8, attackerId: "agent-a" },
        { sequence: 9, attackerId: "outside" },
      ],
      lastBowTransitionSequence: 3,
      lastArrowSpawnSequence: 7,
      lastArrowCancellationSequence: 9,
    });

    expect(selected.transitions.map((entry) => entry.sequence)).toEqual([4, 5]);
    expect(selected.spawnEvents.map((entry) => entry.sequence)).toEqual([8]);
    expect(selected.cancellationEvents.map((entry) => entry.sequence)).toEqual([
      10,
    ]);
    expect(selected.activeArrows.map((entry) => entry.sequence)).toEqual([8]);
  });

  test("accepts repeated two-contestant visual handoffs", () => {
    const summary = summarizeDuelRangedTransitionTelemetry(snapshots());
    expect(summary.ok).toBe(true);
    expect(summary.metrics.agents).toHaveLength(2);
    expect(
      summary.metrics.agents.every((agent) => agent.pairedCount === 2),
    ).toBe(true);
  });

  test("accepts an exact server cancellation as the sole terminal event", () => {
    const series = snapshots();
    const source = series[1].spawnEvents[1];
    const extraSpawn = {
      ...source,
      sequence: 5,
      projectileId: "projectile-5",
      networkEventId: "server-a:launch-5",
      performanceTimeMs: 1_802,
    };
    const active = (progress) => ({
      ...extraSpawn,
      currentPosition: [
        extraSpawn.startPosition[0] +
          (extraSpawn.targetPosition[0] - extraSpawn.startPosition[0]) *
            progress,
        1.2,
        0,
      ],
      elapsedMs: extraSpawn.travelDurationMs * progress,
      distanceTraveled:
        Math.abs(extraSpawn.targetPosition[0] - extraSpawn.startPosition[0]) *
        progress,
      flightProgress: progress,
    });
    series[1].transitions.push(
      {
        sequence: 9,
        playerId: "ranger-b",
        itemId: "shortbow",
        kind: "scheduled",
        performanceTimeMs: 1_400,
        releaseAtPerformanceTimeMs: 1_800,
        networkEventId: "server-a:launch-5",
      },
      {
        sequence: 10,
        playerId: "ranger-b",
        itemId: "shortbow",
        kind: "released",
        performanceTimeMs: 1_800,
        lastVisibleNockWorldPosition: source.startPosition,
        drawHandWorldPosition: source.startPosition,
        networkEventId: "server-a:launch-5",
      },
    );
    series[1].spawnEvents.push(extraSpawn);
    series[1].activeArrows.push(active(0.1));
    series[2].activeArrows.push(active(0.65));
    series[3].cancellationEvents = [
      {
        sequence: 1,
        launchSequence: 5,
        attackerId: "ranger-b",
        targetId: "ranger-a",
        arrowId: "bronze_arrow",
        projectileId: "projectile-5",
        launchNetworkEventId: "server-a:launch-5",
        networkEventId: "server-a:cancel-5",
        performanceTimeMs: 2_500,
        reason: "entity_died",
        visualFound: true,
      },
    ];

    const summary = summarizeDuelRangedTransitionTelemetry(series);

    expect(summary.ok).toBe(true);
    expect(summary.metrics).toMatchObject({
      cancellationCount: 1,
      orphanCancellationCount: 0,
      crossTerminalProjectileCount: 0,
      unterminatedSpawnCount: 0,
      cancellationVisualMissingCount: 0,
    });
  });

  test("recognizes the production magic shortbow as ranged bow equipment", () => {
    const summary = summarizeDuelRangedTransitionTelemetry(
      snapshots({ bowItemId: "magic_shortbow" }),
    );

    expect(summary.ok).toBe(true);
    expect(
      summary.metrics.agents.every(
        (agent) =>
          agent.roleEquipmentMismatchSamples === 0 &&
          agent.controllerReadySamples > 0,
      ),
    ).toBe(true);
  });

  test("accounts for an in-flight projectile at the evidence boundary", () => {
    const series = snapshots();
    const boundarySpawn = {
      sequence: 100,
      attackerId: "ranger-a",
      targetId: "ranger-b",
      arrowId: "bronze_arrow",
      projectileId: "projectile-before-window",
      performanceTimeMs: -500,
      startPosition: [0, 1.2, 0],
      targetPosition: [4, 1.2, 0],
      travelDurationMs: 600,
      networkEventId: "server-a:launch-before-window",
    };
    series[0].activeArrows.push({
      ...boundarySpawn,
      currentPosition: [3, 1.2, 0],
      elapsedMs: 450,
      distanceTraveled: 3,
      flightProgress: 0.75,
    });
    series[1].impactEvents.push({
      sequence: 100,
      launchSequence: boundarySpawn.sequence,
      attackerId: boundarySpawn.attackerId,
      targetId: boundarySpawn.targetId,
      arrowId: boundarySpawn.arrowId,
      projectileId: boundarySpawn.projectileId,
      networkEventId: "server-a:impact-before-window",
      performanceTimeMs: 25,
      impactPosition: boundarySpawn.targetPosition,
      travelledMetres: 4,
      flightProgress: 1,
      damage: 7,
      visualFound: true,
      impactParticleCount: 7,
    });
    series[1].damageEvents.push({
      sequence: 100,
      projectileId: boundarySpawn.projectileId,
      attackerId: boundarySpawn.attackerId,
      targetId: boundarySpawn.targetId,
      attackType: "ranged",
      targetType: "player",
      damage: 7,
      isCritical: false,
      performanceTimeMs: 20,
      hitReactionTriggered: true,
      hitReactionTriggerCount: 100,
      damageSplatCreated: true,
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(true);
    expect(summary.metrics).toMatchObject({
      boundaryProjectileCount: 1,
      boundaryImpactCount: 1,
      boundaryDamageCount: 1,
      boundaryPairMismatchCount: 0,
      orphanImpactCount: 0,
    });
  });

  test("rejects equal boundary totals that belong to different projectile identities", () => {
    const series = snapshots();
    series[0].activeArrows.push(
      { sequence: 901, projectileId: "boundary-impact-only" },
      { sequence: 902, projectileId: "boundary-damage-only" },
    );
    series[1].impactEvents.push({
      sequence: 901,
      projectileId: "boundary-impact-only",
      networkEventId: "server-a:boundary-impact-only",
    });
    series[1].damageEvents.push({
      sequence: 902,
      projectileId: "boundary-damage-only",
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    const identityCheck = summary.checks.find((entry) =>
      entry.label.includes("identities terminate one-to-one"),
    );

    expect(summary.ok).toBe(false);
    expect(identityCheck?.pass).toBe(false);
    expect(summary.metrics).toMatchObject({
      boundaryImpactCount: 1,
      boundaryDamageCount: 1,
      boundaryPairMismatchCount: 2,
    });
  });

  test("allows a prior arrow in flight while the next authoritative arrow is nocked", () => {
    const series = snapshots();
    series[1].players[0].nockedArrowVisible = true;
    series[1].transitions.push({
      sequence: 9,
      playerId: "ranger-a",
      itemId: "shortbow",
      kind: "scheduled",
      performanceTimeMs: 1_500,
      releaseAtPerformanceTimeMs: 1_900,
      networkEventId: "server-a:launch-5",
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.metrics.overlapSampleCount).toBe(0);
  });

  test("accounts for a scheduled release still inside the capture-end deadline", () => {
    const series = snapshots();
    series[3].performanceTimeMs = 1_800;
    series[3].players[0].nockedArrowVisible = true;
    series[3].players[0].nockedArrowWorldPosition = [0, 1.2, 0];
    series[3].transitions.push({
      sequence: 9,
      playerId: "ranger-a",
      itemId: "shortbow",
      kind: "scheduled",
      performanceTimeMs: 1_700,
      releaseAtPerformanceTimeMs: 2_100,
      networkEventId: "server-a:launch-boundary",
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    const ranger = summary.metrics.agents.find(
      (agent) => agent.playerId === "ranger-a",
    );

    expect(summary.ok).toBe(true);
    expect(ranger).toMatchObject({
      scheduledCount: 3,
      releasedCount: 2,
      pendingBoundaryScheduledCount: 1,
      overdueScheduledCount: 0,
    });
  });

  test("rejects a scheduled release that remains overdue at capture end", () => {
    const series = snapshots();
    series[3].performanceTimeMs = 2_500;
    series[3].players[0].nockedArrowVisible = true;
    series[3].players[0].nockedArrowWorldPosition = [0, 1.2, 0];
    series[3].transitions.push({
      sequence: 9,
      playerId: "ranger-a",
      itemId: "shortbow",
      kind: "scheduled",
      performanceTimeMs: 1_700,
      releaseAtPerformanceTimeMs: 2_100,
      networkEventId: "server-a:launch-overdue",
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    const ranger = summary.metrics.agents.find(
      (agent) => agent.playerId === "ranger-a",
    );

    expect(summary.ok).toBe(false);
    expect(ranger).toMatchObject({
      pendingBoundaryScheduledCount: 0,
      overdueScheduledCount: 1,
    });
  });

  test("rejects a visible nock-to-projectile position pop", () => {
    const summary = summarizeDuelRangedTransitionTelemetry(
      snapshots({ gap: 0.2 }),
    );
    expect(summary.ok).toBe(false);
    expect(
      summary.checks.find((entry) => entry.label.includes("last visible nock"))
        ?.pass,
    ).toBe(false);
  });

  test("rejects missing dynamic-bow authority", () => {
    const summary = summarizeDuelRangedTransitionTelemetry(
      snapshots({ controllerReady: false }),
    );
    expect(summary.ok).toBe(false);
    expect(
      summary.checks.find((entry) =>
        entry.label.includes("controller remains ready"),
      )?.pass,
    ).toBe(false);
  });

  test("rejects projectiles that are present but never advance across frames", () => {
    const series = snapshots();
    const startByProjectile = new Map(
      series.flatMap((snapshot) =>
        snapshot.spawnEvents.map((spawn) => [
          spawn.projectileId,
          spawn.startPosition,
        ]),
      ),
    );
    for (const snapshot of series) {
      for (const arrow of snapshot.activeArrows) {
        arrow.currentPosition = startByProjectile.get(arrow.projectileId);
        arrow.flightProgress = 0.1;
      }
    }

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(false);
    expect(
      summary.checks.find((entry) =>
        entry.label.includes("advancing arrow flights"),
      )?.pass,
    ).toBe(false);
  });

  test("rejects an impact without the visible burst and exact hit feedback", () => {
    const series = snapshots();
    series[1].impactEvents[0].visualFound = false;
    series[1].impactEvents[0].impactParticleCount = 0;
    series[1].damageEvents[0].hitReactionTriggered = false;
    series[1].damageEvents[0].hitReactionTriggerCount = null;

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(false);
    expect(
      summary.checks.find((entry) =>
        entry.label.includes("authoritative impact presentations"),
      )?.pass,
    ).toBe(false);
  });

  test("rejects a projectile that expires before authoritative impact", () => {
    const series = snapshots();
    for (const snapshot of series) {
      snapshot.arrowExpiredBeforeImpactCount = 1;
      snapshot.arrowExpiredBeforeImpactDelta = 1;
    }

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(false);
    expect(
      summary.checks.find((entry) => entry.label.includes("expires before"))
        ?.pass,
    ).toBe(false);
  });

  test("accepts one bounded role/equipment projection handoff", () => {
    const series = snapshots();
    series.push({
      observedAt: 500,
      rangedPlayerIds: ["ranger-a"],
      players: [
        {
          ...series[1].players[0],
          role: "ranged",
          itemId: "bronze_shortsword",
          controllerReady: false,
        },
        { ...series[1].players[1], role: "melee", itemId: "bronze_shortsword" },
      ],
      transitions: [],
      spawnEvents: [],
      activeArrows: [],
      arrowCancelledBeforeSpawnCount: 0,
    });
    series.push({
      ...series[2],
      observedAt: 750,
      rangedPlayerIds: [],
      players: series[2].players.map((player) => ({
        ...player,
        role: "melee",
        itemId: "bronze_shortsword",
      })),
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(true);
    expect(summary.metrics.agents[0]).toMatchObject({
      roleEquipmentMismatchSamples: 1,
      unboundedRoleEquipmentMismatchSamples: 0,
      controllerMissingSamples: 0,
    });
  });

  test("rejects a sustained role/equipment projection mismatch", () => {
    const series = snapshots();
    for (const observedAt of [500, 1_000]) {
      series.push({
        observedAt,
        rangedPlayerIds: ["ranger-a"],
        players: [
          {
            ...series[1].players[0],
            role: "ranged",
            itemId: "bronze_shortsword",
            controllerReady: false,
          },
          {
            ...series[1].players[1],
            role: "melee",
            itemId: "bronze_shortsword",
          },
        ],
        transitions: [],
        spawnEvents: [],
        activeArrows: [],
        arrowCancelledBeforeSpawnCount: 0,
      });
    }

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(false);
    expect(
      summary.metrics.agents[0].unboundedRoleEquipmentMismatchSamples,
    ).toBe(1);
  });

  test("rejects duplicate nearby-region delivery of one projectile launch", () => {
    const series = snapshots();
    const original = series[1].spawnEvents[0];
    series[1].spawnEvents.push({
      ...original,
      sequence: 99,
    });

    const summary = summarizeDuelRangedTransitionTelemetry(series);
    expect(summary.ok).toBe(false);
    expect(summary.metrics.duplicateSpawnCount).toBe(1);
    expect(summary.metrics.maximumCopiesPerSpawnEvent).toBe(2);
    expect(
      summary.checks.find((entry) =>
        entry.label.includes("one projectile visual"),
      )?.pass,
    ).toBe(false);
  });

  test("retains an earlier cancelled-before-spawn failure after samples rotate", () => {
    const series = snapshots();
    for (const snapshot of series) {
      snapshot.arrowCancelledBeforeSpawnCount = 7;
      snapshot.arrowCancelledBeforeSpawnDelta = 1;
    }

    const summary = summarizeDuelRangedTransitionTelemetry(series.slice(1));
    expect(summary.ok).toBe(false);
    expect(
      summary.checks.find((entry) => entry.label.includes("cancelled before"))
        ?.actual,
    ).toBe("1");
  });
});
