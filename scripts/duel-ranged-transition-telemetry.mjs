export const DUEL_RANGED_TRANSITION_LIMITS = Object.freeze({
  minimumTransitionsPerRangedAgent: 2,
  maximumReleaseSpawnDeltaMs: 250,
  maximumLastVisibleNockToSpawnMetres: 0.12,
  maximumReleaseHandToSpawnMetres: 0.05,
  maximumRoleEquipmentProjectionLagMs: 750,
  minimumFlightPositionSamples: 2,
  minimumFlightAdvanceMetres: 0.25,
  minimumFlightProgressAdvance: 0.1,
  maximumDamageImpactDeltaMs: 250,
  minimumArrowImpactParticles: 7,
  maximumReleaseSettlementGraceMs: 250,
});

/**
 * Select presentation events for either contestant, not only the contestant
 * whose current frozen role is ranged. A launch can be followed by an atomic
 * style switch before the next browser poll; dropping the former ranger's
 * release/spawn would turn a valid handoff into malformed evidence.
 */
export function selectDuelRangedPresentationEvents({
  duelPlayerIds,
  recentTransitions,
  recentArrowSpawns,
  recentArrowImpacts,
  recentArrowCancellations,
  recentDamageEvents,
  activeArrows,
  lastBowTransitionSequence,
  lastArrowSpawnSequence,
  lastArrowImpactSequence = 0,
  lastArrowCancellationSequence = 0,
  lastDamageSequence = 0,
}) {
  const allowed = new Set(duelPlayerIds ?? []);
  return {
    transitions: (recentTransitions ?? []).filter(
      (transition) =>
        transition?.sequence > lastBowTransitionSequence &&
        allowed.has(transition?.playerId),
    ),
    spawnEvents: (recentArrowSpawns ?? []).filter(
      (spawn) =>
        spawn?.sequence > lastArrowSpawnSequence &&
        allowed.has(spawn?.attackerId),
    ),
    impactEvents: (recentArrowImpacts ?? []).filter(
      (impact) =>
        impact?.sequence > lastArrowImpactSequence &&
        allowed.has(impact?.attackerId),
    ),
    cancellationEvents: (recentArrowCancellations ?? []).filter(
      (cancellation) =>
        cancellation?.sequence > lastArrowCancellationSequence &&
        allowed.has(cancellation?.attackerId),
    ),
    damageEvents: (recentDamageEvents ?? []).filter(
      (damage) =>
        damage?.sequence > lastDamageSequence &&
        allowed.has(damage?.attackerId) &&
        allowed.has(damage?.targetId),
    ),
    activeArrows: (activeArrows ?? []).filter((arrow) =>
      allowed.has(arrow?.attackerId),
    ),
  };
}

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function percentile(values, quantile) {
  const finite = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (finite.length === 0) return null;
  return round(
    finite[
      Math.min(finite.length - 1, Math.ceil(finite.length * quantile) - 1)
    ],
  );
}

function distance(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== 3 ||
    right.length !== 3
  ) {
    return null;
  }
  const delta = left.map(
    (value, index) => Number(value) - Number(right[index]),
  );
  return delta.every(Number.isFinite) ? Math.hypot(...delta) : null;
}

function check(label, pass, actual) {
  return { label, pass: pass === true, actual: String(actual) };
}

function isBowItemId(itemId) {
  return (
    typeof itemId === "string" &&
    /(?:^|_)(?:shortbow|longbow|bow)$/.test(itemId)
  );
}

function uniqueBySequence(events) {
  const unique = new Map();
  for (const event of events) {
    if (Number.isSafeInteger(event?.sequence) && event.sequence >= 0) {
      unique.set(event.sequence, event);
    }
  }
  return [...unique.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function findDuplicateSpawnGroups(spawns) {
  const groups = new Map();
  for (const spawn of spawns) {
    const identity =
      typeof spawn.networkEventId === "string" &&
      spawn.networkEventId.length > 0
        ? `event:${spawn.networkEventId}`
        : [
            "legacy",
            spawn.attackerId,
            spawn.targetId,
            spawn.arrowId ?? "",
            spawn.performanceTimeMs,
          ].join("|");
    const group = groups.get(identity) ?? [];
    group.push(spawn.sequence);
    groups.set(identity, group);
  }
  return [...groups.entries()]
    .filter(([, sequences]) => sequences.length > 1)
    .map(([identity, sequences]) => ({ identity, sequences }));
}

function pairTransitions(releases, spawns) {
  const available = new Set(spawns.map((spawn) => spawn.sequence));
  return releases.flatMap((release) => {
    const candidates = spawns
      .filter(
        (spawn) =>
          available.has(spawn.sequence) &&
          spawn.attackerId === release.playerId &&
          (release.networkEventId
            ? spawn.networkEventId === release.networkEventId
            : spawn.networkEventId == null),
      )
      .map((spawn) => ({
        spawn,
        deltaMs: Math.abs(spawn.performanceTimeMs - release.performanceTimeMs),
      }))
      .sort(
        (left, right) =>
          left.deltaMs - right.deltaMs ||
          left.spawn.sequence - right.spawn.sequence,
      );
    const match = candidates[0];
    if (
      !match ||
      match.deltaMs > DUEL_RANGED_TRANSITION_LIMITS.maximumReleaseSpawnDeltaMs
    ) {
      return [];
    }
    available.delete(match.spawn.sequence);
    return [
      {
        releaseSequence: release.sequence,
        spawnSequence: match.spawn.sequence,
        releaseSpawnDeltaMs: round(match.deltaMs),
        lastVisibleNockToSpawnMetres: round(
          distance(
            release.lastVisibleNockWorldPosition,
            match.spawn.startPosition,
          ),
        ),
        releaseHandToSpawnMetres: round(
          distance(release.drawHandWorldPosition, match.spawn.startPosition),
        ),
      },
    ];
  });
}

function groupByProjectileId(events) {
  const groups = new Map();
  for (const event of events) {
    if (typeof event?.projectileId !== "string" || !event.projectileId) {
      continue;
    }
    const group = groups.get(event.projectileId) ?? [];
    group.push(event);
    groups.set(event.projectileId, group);
  }
  return groups;
}

function collectFlightObservations(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    for (const arrow of snapshot.activeArrows ?? []) {
      if (typeof arrow?.projectileId !== "string" || !arrow.projectileId) {
        continue;
      }
      const group = groups.get(arrow.projectileId) ?? [];
      group.push({ ...arrow, observedAt: snapshot.observedAt });
      groups.set(arrow.projectileId, group);
    }
  }
  return groups;
}

function summarizeFlight(spawn, observations) {
  const ordered = [...(observations ?? [])].sort(
    (left, right) => left.observedAt - right.observedAt,
  );
  const positions = ordered
    .map((observation) => observation.currentPosition)
    .filter((position) => distance(position, position) === 0);
  const progress = ordered
    .map((observation) => observation.flightProgress)
    .filter(Number.isFinite);
  let maximumObservedAdvanceMetres = 0;
  for (let left = 0; left < positions.length; left++) {
    for (let right = left + 1; right < positions.length; right++) {
      maximumObservedAdvanceMetres = Math.max(
        maximumObservedAdvanceMetres,
        distance(positions[left], positions[right]) ?? 0,
      );
    }
  }
  const maximumDistanceFromStartMetres = positions.reduce(
    (maximum, position) =>
      Math.max(maximum, distance(spawn.startPosition, position) ?? 0),
    0,
  );
  const progressAdvance = progress.length
    ? Math.max(...progress) - Math.min(...progress)
    : 0;
  return {
    projectileId: spawn.projectileId ?? null,
    sampleCount: ordered.length,
    maximumObservedAdvanceMetres: round(maximumObservedAdvanceMetres),
    maximumDistanceFromStartMetres: round(maximumDistanceFromStartMetres),
    progressAdvance: round(progressAdvance),
    pass:
      ordered.length >=
        DUEL_RANGED_TRANSITION_LIMITS.minimumFlightPositionSamples &&
      maximumObservedAdvanceMetres >=
        DUEL_RANGED_TRANSITION_LIMITS.minimumFlightAdvanceMetres &&
      progressAdvance >=
        DUEL_RANGED_TRANSITION_LIMITS.minimumFlightProgressAdvance,
  };
}

function pairImpactPresentation(impact, spawn, damageEvents) {
  const damage = damageEvents.find(
    (event) => event.projectileId === impact.projectileId,
  );
  const damageImpactDeltaMs = damage
    ? Math.abs(damage.performanceTimeMs - impact.performanceTimeMs)
    : null;
  const hitFeedbackMatches = Boolean(
    damage &&
    damage.attackerId === impact.attackerId &&
    damage.targetId === impact.targetId &&
    damage.damage === impact.damage &&
    damage.attackType === "ranged" &&
    damage.targetType === "player" &&
    damage.damageSplatCreated === true &&
    (impact.damage > 0
      ? damage.hitReactionTriggered === true &&
        Number.isSafeInteger(damage.hitReactionTriggerCount) &&
        damage.hitReactionTriggerCount > 0
      : damage.hitReactionTriggered === false),
  );
  return {
    projectileId: impact.projectileId ?? null,
    spawnSequence: spawn?.sequence ?? null,
    impactSequence: impact.sequence,
    damageSequence: damage?.sequence ?? null,
    damageImpactDeltaMs: round(damageImpactDeltaMs),
    visualFound: impact.visualFound === true,
    impactParticleCount: impact.impactParticleCount,
    hitFeedbackMatches,
    pass: Boolean(
      spawn &&
      damage &&
      impact.visualFound === true &&
      Array.isArray(impact.impactPosition) &&
      impact.impactParticleCount >=
        DUEL_RANGED_TRANSITION_LIMITS.minimumArrowImpactParticles &&
      damageImpactDeltaMs !== null &&
      damageImpactDeltaMs <=
        DUEL_RANGED_TRANSITION_LIMITS.maximumDamageImpactDeltaMs &&
      hitFeedbackMatches,
    ),
  };
}

export function summarizeDuelRangedTransitionTelemetry(snapshots) {
  const ordered = [...(snapshots ?? [])].sort(
    (left, right) => left.observedAt - right.observedAt,
  );
  const rangedAgentIds = [
    ...new Set(ordered.flatMap((snapshot) => snapshot.rangedPlayerIds ?? [])),
  ].sort();
  const transitions = uniqueBySequence(
    ordered.flatMap((snapshot) => snapshot.transitions ?? []),
  );
  const spawns = uniqueBySequence(
    ordered.flatMap((snapshot) => snapshot.spawnEvents ?? []),
  );
  const impacts = uniqueBySequence(
    ordered.flatMap((snapshot) => snapshot.impactEvents ?? []),
  );
  const cancellations = uniqueBySequence(
    ordered.flatMap((snapshot) => snapshot.cancellationEvents ?? []),
  );
  const damageEvents = uniqueBySequence(
    ordered.flatMap((snapshot) => snapshot.damageEvents ?? []),
  ).filter((event) => typeof event.projectileId === "string");
  const latestPerformanceTimeMs = Number.isFinite(
    ordered.at(-1)?.performanceTimeMs,
  )
    ? ordered.at(-1).performanceTimeMs
    : Math.max(
        0,
        ...transitions.map((event) => Number(event.performanceTimeMs) || 0),
        ...spawns.map((event) => Number(event.performanceTimeMs) || 0),
        ...impacts.map((event) => Number(event.performanceTimeMs) || 0),
        ...cancellations.map((event) => Number(event.performanceTimeMs) || 0),
        ...damageEvents.map((event) => Number(event.performanceTimeMs) || 0),
      );
  // The capture can be admitted while an already-launched arrow is in flight.
  // Its later impact is valid boundary traffic, but its launch necessarily
  // predates the evidence window. Keep that traffic explicit instead of
  // misclassifying it as an orphan or silently weakening the owned-projectile
  // checks.
  const capturedSpawnProjectileIds = new Set(
    spawns.flatMap((spawn) =>
      typeof spawn?.projectileId === "string" ? [spawn.projectileId] : [],
    ),
  );
  const boundaryProjectileIds = new Set(
    (ordered[0]?.activeArrows ?? []).flatMap((arrow) =>
      typeof arrow?.projectileId === "string" &&
      !capturedSpawnProjectileIds.has(arrow.projectileId)
        ? [arrow.projectileId]
        : [],
    ),
  );
  const boundaryImpacts = impacts.filter((impact) =>
    boundaryProjectileIds.has(impact.projectileId),
  );
  const boundaryDamageEvents = damageEvents.filter((damage) =>
    boundaryProjectileIds.has(damage.projectileId),
  );
  const boundaryCancellations = cancellations.filter((cancellation) =>
    boundaryProjectileIds.has(cancellation.projectileId),
  );
  const boundaryImpactGroupsByProjectileId =
    groupByProjectileId(boundaryImpacts);
  const boundaryDamageGroupsByProjectileId =
    groupByProjectileId(boundaryDamageEvents);
  const boundaryCancellationGroupsByProjectileId = groupByProjectileId(
    boundaryCancellations,
  );
  const boundaryPairMismatchCount = [...boundaryProjectileIds].filter(
    (projectileId) => {
      const impactCount =
        boundaryImpactGroupsByProjectileId.get(projectileId)?.length ?? 0;
      const damageCount =
        boundaryDamageGroupsByProjectileId.get(projectileId)?.length ?? 0;
      const cancellationCount =
        boundaryCancellationGroupsByProjectileId.get(projectileId)?.length ?? 0;
      return !(
        (impactCount === 0 && damageCount === 0 && cancellationCount === 0) ||
        (impactCount === 1 && damageCount === 1 && cancellationCount === 0) ||
        (impactCount === 0 && damageCount === 0 && cancellationCount === 1)
      );
    },
  ).length;
  const ownedImpacts = impacts.filter(
    (impact) => !boundaryProjectileIds.has(impact.projectileId),
  );
  const ownedDamageEvents = damageEvents.filter(
    (damage) => !boundaryProjectileIds.has(damage.projectileId),
  );
  const ownedCancellations = cancellations.filter(
    (cancellation) => !boundaryProjectileIds.has(cancellation.projectileId),
  );
  const spawnGroupsByProjectileId = groupByProjectileId(spawns);
  const impactGroupsByProjectileId = groupByProjectileId(ownedImpacts);
  const damageGroupsByProjectileId = groupByProjectileId(ownedDamageEvents);
  const cancellationGroupsByProjectileId =
    groupByProjectileId(ownedCancellations);
  const flightObservationsByProjectileId = collectFlightObservations(ordered);
  const duplicateSpawnGroups = findDuplicateSpawnGroups(spawns);
  const duplicateSpawnCount = duplicateSpawnGroups.reduce(
    (total, group) => total + group.sequences.length - 1,
    0,
  );
  const pendingLaunchByPlayer = new Map();
  const overlapSamples = [];
  for (const snapshot of ordered) {
    for (const transition of [...(snapshot.transitions ?? [])].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (transition.kind === "scheduled" && transition.networkEventId) {
        pendingLaunchByPlayer.set(
          transition.playerId,
          transition.networkEventId,
        );
      } else if (
        (transition.kind === "released" || transition.kind === "cancelled") &&
        pendingLaunchByPlayer.get(transition.playerId) ===
          transition.networkEventId
      ) {
        pendingLaunchByPlayer.delete(transition.playerId);
      }
    }
    const overlappingPlayerIds = (snapshot.players ?? []).flatMap((player) => {
      if (player.nockedArrowVisible !== true) return [];
      const pendingEventId = pendingLaunchByPlayer.get(player.playerId);
      if (!pendingEventId) return [];
      return (snapshot.activeArrows ?? []).some(
        (arrow) =>
          arrow.attackerId === player.playerId &&
          arrow.networkEventId === pendingEventId,
      )
        ? [player.playerId]
        : [];
    });
    if (overlappingPlayerIds.length > 0) {
      overlapSamples.push({
        observedAt: snapshot.observedAt,
        playerIds: overlappingPlayerIds,
      });
    }
  }

  const agents = rangedAgentIds.map((playerId) => {
    const playerSamples = ordered.flatMap((snapshot) =>
      (snapshot.players ?? [])
        .filter((player) => player.playerId === playerId)
        .map((player) => ({
          ...player,
          observedAt: snapshot.observedAt,
          role:
            typeof player.role === "string"
              ? player.role
              : (snapshot.rangedPlayerIds ?? []).includes(playerId)
                ? "ranged"
                : null,
        })),
    );
    const roleEquipmentMismatches = playerSamples.filter(
      (player) => (player.role === "ranged") !== isBowItemId(player.itemId),
    );
    const boundedRoleEquipmentMismatches = roleEquipmentMismatches.filter(
      (mismatch) => {
        const index = playerSamples.indexOf(mismatch);
        return [playerSamples[index - 1], playerSamples[index + 1]].some(
          (adjacent) =>
            adjacent &&
            (adjacent.role === "ranged") === isBowItemId(adjacent.itemId) &&
            (adjacent.role !== mismatch.role ||
              adjacent.itemId !== mismatch.itemId) &&
            Math.abs(adjacent.observedAt - mismatch.observedAt) <=
              DUEL_RANGED_TRANSITION_LIMITS.maximumRoleEquipmentProjectionLagMs,
        );
      },
    );
    const rangedBowSamples = playerSamples.filter(
      (player) => player.role === "ranged" && isBowItemId(player.itemId),
    );
    const releases = transitions.filter(
      (transition) =>
        transition.kind === "released" && transition.playerId === playerId,
    );
    const scheduled = transitions.filter(
      (transition) =>
        transition.kind === "scheduled" && transition.playerId === playerId,
    );
    const cancelled = transitions.filter(
      (transition) =>
        transition.kind === "cancelled" && transition.playerId === playerId,
    );
    const terminalNetworkEventIds = new Set(
      [...releases, ...cancelled].flatMap((transition) =>
        typeof transition.networkEventId === "string"
          ? [transition.networkEventId]
          : [],
      ),
    );
    // A bounded capture is allowed to finish while the next arrow is visibly
    // nocked and its authored release deadline has not yet settled. Count only
    // that exact deadline/grace interval as a boundary event; an overdue nock
    // remains a hard failure and therefore still detects a stuck controller.
    const pendingBoundarySchedules = scheduled.filter(
      (transition) =>
        typeof transition.networkEventId === "string" &&
        !terminalNetworkEventIds.has(transition.networkEventId) &&
        Number.isFinite(transition.releaseAtPerformanceTimeMs) &&
        latestPerformanceTimeMs <=
          transition.releaseAtPerformanceTimeMs +
            DUEL_RANGED_TRANSITION_LIMITS.maximumReleaseSettlementGraceMs,
    );
    const overdueScheduledCount = scheduled.filter(
      (transition) =>
        typeof transition.networkEventId !== "string" ||
        (!terminalNetworkEventIds.has(transition.networkEventId) &&
          !pendingBoundarySchedules.includes(transition)),
    ).length;
    const agentSpawns = spawns.filter((spawn) => spawn.attackerId === playerId);
    const agentImpacts = ownedImpacts.filter(
      (impact) => impact.attackerId === playerId,
    );
    const flightProofs = agentSpawns.map((spawn) =>
      summarizeFlight(
        spawn,
        flightObservationsByProjectileId.get(spawn.projectileId) ?? [],
      ),
    );
    const impactPresentationProofs = agentImpacts.map((impact) =>
      pairImpactPresentation(
        impact,
        (spawnGroupsByProjectileId.get(impact.projectileId) ?? [])[0],
        ownedDamageEvents,
      ),
    );
    const completedFlightProofs = flightProofs.filter(
      (proof) =>
        proof.pass &&
        (impactGroupsByProjectileId.get(proof.projectileId) ?? []).length === 1,
    );
    const pairs = pairTransitions(releases, agentSpawns);
    const releaseSpawnDeltas = pairs
      .map((pair) => pair.releaseSpawnDeltaMs)
      .filter(Number.isFinite);
    const nockSpawnDistances = pairs
      .map((pair) => pair.lastVisibleNockToSpawnMetres)
      .filter(Number.isFinite);
    const handSpawnDistances = pairs
      .map((pair) => pair.releaseHandToSpawnMetres)
      .filter(Number.isFinite);
    return {
      playerId,
      controllerReadySamples: rangedBowSamples.filter(
        (player) => player.controllerReady === true,
      ).length,
      controllerMissingSamples: rangedBowSamples.filter(
        (player) => player.controllerReady !== true,
      ).length,
      visibleNockSamples: rangedBowSamples.filter(
        (player) => player.nockedArrowVisible === true,
      ).length,
      roleEquipmentMismatchSamples: roleEquipmentMismatches.length,
      unboundedRoleEquipmentMismatchSamples:
        roleEquipmentMismatches.length - boundedRoleEquipmentMismatches.length,
      activeArrowSamples: ordered.filter((snapshot) =>
        (snapshot.activeArrows ?? []).some(
          (arrow) => arrow.attackerId === playerId,
        ),
      ).length,
      scheduledCount: scheduled.length,
      pendingBoundaryScheduledCount: pendingBoundarySchedules.length,
      overdueScheduledCount,
      releasedCount: releases.length,
      cancelledCount: cancelled.length,
      spawnedCount: agentSpawns.length,
      impactCount: agentImpacts.length,
      completedFlightCount: completedFlightProofs.length,
      impactPresentationPassCount: impactPresentationProofs.filter(
        (proof) => proof.pass,
      ).length,
      pairedCount: pairs.length,
      releaseSpawnDeltaMs: {
        p95: percentile(releaseSpawnDeltas, 0.95),
        max: releaseSpawnDeltas.length
          ? round(Math.max(...releaseSpawnDeltas))
          : null,
      },
      lastVisibleNockToSpawnMetres: {
        p95: percentile(nockSpawnDistances, 0.95),
        max:
          nockSpawnDistances.length === pairs.length && pairs.length > 0
            ? round(Math.max(...nockSpawnDistances))
            : null,
      },
      releaseHandToSpawnMetres: {
        p95: percentile(handSpawnDistances, 0.95),
        max:
          handSpawnDistances.length === pairs.length && pairs.length > 0
            ? round(Math.max(...handSpawnDistances))
            : null,
      },
      pairs,
      flightProofs,
      impactPresentationProofs,
    };
  });

  const latest = ordered.at(-1);
  const cancelledBeforeSpawnDelta = latest
    ? Number.isSafeInteger(latest.arrowCancelledBeforeSpawnDelta) &&
      latest.arrowCancelledBeforeSpawnDelta >= 0
      ? latest.arrowCancelledBeforeSpawnDelta
      : Math.max(
          0,
          Number(latest.arrowCancelledBeforeSpawnCount ?? 0) -
            Number(ordered[0]?.arrowCancelledBeforeSpawnCount ?? 0),
        )
    : 0;
  const expiredBeforeImpactDelta = latest
    ? Number.isSafeInteger(latest.arrowExpiredBeforeImpactDelta) &&
      latest.arrowExpiredBeforeImpactDelta >= 0
      ? latest.arrowExpiredBeforeImpactDelta
      : Math.max(
          0,
          Number(latest.arrowExpiredBeforeImpactCount ?? 0) -
            Number(ordered[0]?.arrowExpiredBeforeImpactCount ?? 0),
        )
    : 0;
  const duplicateProjectileSpawnCount = [...spawnGroupsByProjectileId.values()]
    .filter((group) => group.length > 1)
    .reduce((total, group) => total + group.length - 1, 0);
  const duplicateProjectileImpactCount = [
    ...impactGroupsByProjectileId.values(),
  ]
    .filter((group) => group.length > 1)
    .reduce((total, group) => total + group.length - 1, 0);
  const duplicateProjectileDamageCount = [
    ...damageGroupsByProjectileId.values(),
  ]
    .filter((group) => group.length > 1)
    .reduce((total, group) => total + group.length - 1, 0);
  const duplicateProjectileCancellationCount = [
    ...cancellationGroupsByProjectileId.values(),
  ]
    .filter((group) => group.length > 1)
    .reduce((total, group) => total + group.length - 1, 0);
  const orphanImpactCount = ownedImpacts.filter(
    (impact) =>
      typeof impact.projectileId !== "string" ||
      (spawnGroupsByProjectileId.get(impact.projectileId) ?? []).length !== 1,
  ).length;
  const scheduledLaunchNetworkEventIds = new Set(
    transitions.flatMap((transition) =>
      transition.kind === "scheduled" &&
      typeof transition.networkEventId === "string"
        ? [transition.networkEventId]
        : [],
    ),
  );
  const orphanCancellationCount = ownedCancellations.filter((cancellation) => {
    const spawnCount =
      spawnGroupsByProjectileId.get(cancellation.projectileId)?.length ?? 0;
    return !(
      spawnCount === 1 ||
      (spawnCount === 0 &&
        scheduledLaunchNetworkEventIds.has(cancellation.launchNetworkEventId))
    );
  }).length;
  const crossTerminalProjectileCount = [
    ...new Set([
      ...impactGroupsByProjectileId.keys(),
      ...cancellationGroupsByProjectileId.keys(),
    ]),
  ].filter(
    (projectileId) =>
      (impactGroupsByProjectileId.get(projectileId)?.length ?? 0) > 0 &&
      (cancellationGroupsByProjectileId.get(projectileId)?.length ?? 0) > 0,
  ).length;
  const latestActiveProjectileIds = new Set(
    (latest?.activeArrows ?? []).flatMap((arrow) =>
      typeof arrow?.projectileId === "string" ? [arrow.projectileId] : [],
    ),
  );
  const unterminatedSpawnCount = spawns.filter((spawn) => {
    if (latestActiveProjectileIds.has(spawn.projectileId)) return false;
    return (
      (impactGroupsByProjectileId.get(spawn.projectileId)?.length ?? 0) +
        (cancellationGroupsByProjectileId.get(spawn.projectileId)?.length ??
          0) !==
      1
    );
  }).length;
  const cancellationVisualMissingCount = ownedCancellations.filter(
    (cancellation) => cancellation.visualFound !== true,
  ).length;
  const checks = [
    check(
      "at least one ranged contestant is observed",
      rangedAgentIds.length > 0,
      rangedAgentIds.join(",") || "none",
    ),
    ...agents.flatMap((agent) => [
      check(
        `${agent.playerId} bow equipment and public role converge within one bounded projection update`,
        agent.unboundedRoleEquipmentMismatchSamples === 0,
        `mismatches=${agent.roleEquipmentMismatchSamples},unbounded=${agent.unboundedRoleEquipmentMismatchSamples}`,
      ),
      check(
        `${agent.playerId} dynamic bow controller remains ready`,
        agent.controllerReadySamples > 0 &&
          agent.controllerMissingSamples === 0,
        `ready=${agent.controllerReadySamples},missing=${agent.controllerMissingSamples}`,
      ),
      check(
        `${agent.playerId} nocked arrow is observed before release`,
        agent.visibleNockSamples > 0,
        agent.visibleNockSamples,
      ),
      check(
        `${agent.playerId} launched arrow is observed in flight`,
        agent.activeArrowSamples > 0,
        agent.activeArrowSamples,
      ),
      check(
        `${agent.playerId} has repeated advancing arrow flights`,
        agent.completedFlightCount >=
          DUEL_RANGED_TRANSITION_LIMITS.minimumTransitionsPerRangedAgent,
        `completed=${agent.completedFlightCount},proofs=${agent.flightProofs.length}`,
      ),
      check(
        `${agent.playerId} has repeated authoritative impact presentations`,
        agent.impactCount >=
          DUEL_RANGED_TRANSITION_LIMITS.minimumTransitionsPerRangedAgent &&
          agent.impactPresentationPassCount === agent.impactCount,
        `impacts=${agent.impactCount},passed=${agent.impactPresentationPassCount}`,
      ),
      check(
        `${agent.playerId} has repeated scheduled releases`,
        agent.scheduledCount >=
          DUEL_RANGED_TRANSITION_LIMITS.minimumTransitionsPerRangedAgent,
        agent.scheduledCount,
      ),
      check(
        `${agent.playerId} has repeated completed releases`,
        agent.releasedCount >=
          DUEL_RANGED_TRANSITION_LIMITS.minimumTransitionsPerRangedAgent,
        agent.releasedCount,
      ),
      check(
        `${agent.playerId} scheduled releases settle one-to-one outside the capture boundary`,
        agent.overdueScheduledCount === 0 &&
          agent.scheduledCount ===
            agent.releasedCount +
              agent.cancelledCount +
              agent.pendingBoundaryScheduledCount,
        `scheduled=${agent.scheduledCount},released=${agent.releasedCount},cancelled=${agent.cancelledCount},pendingBoundary=${agent.pendingBoundaryScheduledCount},overdue=${agent.overdueScheduledCount}`,
      ),
      check(
        `${agent.playerId} has repeated projectile spawns`,
        agent.spawnedCount >=
          DUEL_RANGED_TRANSITION_LIMITS.minimumTransitionsPerRangedAgent,
        agent.spawnedCount,
      ),
      check(
        `${agent.playerId} release and spawn events pair one-to-one`,
        agent.pairedCount === agent.releasedCount &&
          agent.releasedCount === agent.spawnedCount,
        `released=${agent.releasedCount},spawned=${agent.spawnedCount},paired=${agent.pairedCount}`,
      ),
      check(
        `${agent.playerId} release-to-spawn timing is bounded`,
        agent.releaseSpawnDeltaMs.max !== null &&
          agent.releaseSpawnDeltaMs.max <=
            DUEL_RANGED_TRANSITION_LIMITS.maximumReleaseSpawnDeltaMs,
        agent.releaseSpawnDeltaMs.max ?? "missing",
      ),
      check(
        `${agent.playerId} last visible nock and spawn origin remain continuous`,
        agent.lastVisibleNockToSpawnMetres.max !== null &&
          agent.lastVisibleNockToSpawnMetres.max <=
            DUEL_RANGED_TRANSITION_LIMITS.maximumLastVisibleNockToSpawnMetres,
        agent.lastVisibleNockToSpawnMetres.max ?? "missing",
      ),
      check(
        `${agent.playerId} release-hand and spawn origin remain continuous`,
        agent.releaseHandToSpawnMetres.max !== null &&
          agent.releaseHandToSpawnMetres.max <=
            DUEL_RANGED_TRANSITION_LIMITS.maximumReleaseHandToSpawnMetres,
        agent.releaseHandToSpawnMetres.max ?? "missing",
      ),
    ]),
    check(
      "one authoritative launch never appears both nocked and in flight",
      overlapSamples.length === 0,
      overlapSamples.length,
    ),
    check(
      "bow and projectile diagnostics retain authoritative launch identities",
      transitions.every((transition) => transition.networkEventId) &&
        spawns.every((spawn) => spawn.networkEventId && spawn.projectileId) &&
        ownedImpacts.every(
          (impact) => impact.networkEventId && impact.projectileId,
        ) &&
        ownedDamageEvents.every((damage) => damage.projectileId) &&
        ownedCancellations.every(
          (cancellation) =>
            cancellation.networkEventId && cancellation.projectileId,
        ),
      `transitions=${transitions.filter((transition) => !transition.networkEventId).length},spawns=${spawns.filter((spawn) => !spawn.networkEventId || !spawn.projectileId).length},impacts=${ownedImpacts.filter((impact) => !impact.networkEventId || !impact.projectileId).length},damage=${ownedDamageEvents.filter((damage) => !damage.projectileId).length},cancellations=${ownedCancellations.filter((cancellation) => !cancellation.networkEventId || !cancellation.projectileId).length}`,
    ),
    check(
      "one projectile visual spawns per authoritative launch event",
      duplicateSpawnCount === 0,
      `duplicates=${duplicateSpawnCount},groups=${duplicateSpawnGroups.length}`,
    ),
    check(
      "projectile identities terminate one-to-one by impact or cancellation",
      duplicateProjectileSpawnCount === 0 &&
        duplicateProjectileImpactCount === 0 &&
        duplicateProjectileDamageCount === 0 &&
        duplicateProjectileCancellationCount === 0 &&
        orphanImpactCount === 0 &&
        orphanCancellationCount === 0 &&
        crossTerminalProjectileCount === 0 &&
        unterminatedSpawnCount === 0 &&
        cancellationVisualMissingCount === 0 &&
        ownedImpacts.length === ownedDamageEvents.length &&
        boundaryPairMismatchCount === 0,
      `spawnDuplicates=${duplicateProjectileSpawnCount},impactDuplicates=${duplicateProjectileImpactCount},damageDuplicates=${duplicateProjectileDamageCount},cancellationDuplicates=${duplicateProjectileCancellationCount},orphanImpacts=${orphanImpactCount},orphanCancellations=${orphanCancellationCount},crossTerminals=${crossTerminalProjectileCount},unterminatedSpawns=${unterminatedSpawnCount},missingCancellationVisuals=${cancellationVisualMissingCount},impacts=${ownedImpacts.length},damage=${ownedDamageEvents.length},cancellations=${ownedCancellations.length},boundaryImpacts=${boundaryImpacts.length},boundaryDamage=${boundaryDamageEvents.length},boundaryCancellations=${boundaryCancellations.length},boundaryPairMismatches=${boundaryPairMismatchCount}`,
    ),
    check(
      "no delayed arrow is cancelled before visual spawn",
      cancelledBeforeSpawnDelta === 0,
      cancelledBeforeSpawnDelta,
    ),
    check(
      "no arrow expires before its authoritative impact",
      expiredBeforeImpactDelta === 0,
      expiredBeforeImpactDelta,
    ),
  ];

  return {
    ok: checks.every((entry) => entry.pass),
    limits: DUEL_RANGED_TRANSITION_LIMITS,
    checks,
    metrics: {
      sampleCount: ordered.length,
      rangedAgentIds,
      transitionCount: transitions.length,
      spawnCount: spawns.length,
      impactCount: ownedImpacts.length,
      damageCount: ownedDamageEvents.length,
      boundaryProjectileCount: boundaryProjectileIds.size,
      boundaryImpactCount: boundaryImpacts.length,
      boundaryDamageCount: boundaryDamageEvents.length,
      boundaryCancellationCount: boundaryCancellations.length,
      boundaryPairMismatchCount,
      duplicateSpawnCount,
      duplicateSpawnGroupCount: duplicateSpawnGroups.length,
      maximumCopiesPerSpawnEvent: duplicateSpawnGroups.length
        ? Math.max(
            ...duplicateSpawnGroups.map((group) => group.sequences.length),
          )
        : 1,
      duplicateSpawnGroups,
      overlapSampleCount: overlapSamples.length,
      cancelledBeforeSpawnDelta,
      expiredBeforeImpactDelta,
      duplicateProjectileSpawnCount,
      duplicateProjectileImpactCount,
      duplicateProjectileDamageCount,
      duplicateProjectileCancellationCount,
      orphanImpactCount,
      orphanCancellationCount,
      crossTerminalProjectileCount,
      unterminatedSpawnCount,
      cancellationVisualMissingCount,
      cancellationCount: ownedCancellations.length,
      agents,
    },
  };
}
