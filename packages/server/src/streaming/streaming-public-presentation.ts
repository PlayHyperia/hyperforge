import type {
  RecentDuelEntry,
  StreamingDuelOperationalMetrics,
  StreamingStateUpdate,
  StreamingTerminalNotice,
} from "../systems/StreamingDuelScheduler/types.js";
import {
  STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
  hasValidStreamingGuardrailArenaPositions,
  parseStreamingDuelActionObservation,
  parseStreamingDuelPreparationSummary,
  parseStreamingDuelStrategySummary,
  type StreamingDuelActionObservation,
} from "@hyperforge/shared";

export type PublicCancellationReason =
  | "insufficient_verified_combat"
  | "contestant_unavailable"
  | "broadcast_interrupted"
  | "no_contest";

export type PublicBettingAvailability = {
  ready: boolean;
  unavailableReason:
    "link_unconfigured" | "betting_disabled" | "stream_services_unready" | null;
};

export function derivePublicBettingAvailability(input: {
  betUrl: string | null;
  bettingBridgeEnabled: boolean;
  runtimeReady: boolean;
}): PublicBettingAvailability {
  if (!input.betUrl) {
    return { ready: false, unavailableReason: "link_unconfigured" };
  }
  if (!input.bettingBridgeEnabled) {
    return { ready: false, unavailableReason: "betting_disabled" };
  }
  if (!input.runtimeReady) {
    return { ready: false, unavailableReason: "stream_services_unready" };
  }
  return { ready: true, unavailableReason: null };
}

/** Collapse internal cancellation tokens into a small viewer-safe vocabulary. */
export function toPublicCancellationReason(
  reason: string,
): PublicCancellationReason {
  const normalized = reason.toLowerCase();
  if (normalized.includes("no_combat_activity")) {
    return "insufficient_verified_combat";
  }
  if (
    normalized.includes("missing") ||
    normalized.includes("lost") ||
    normalized.includes("disconnect")
  ) {
    return "contestant_unavailable";
  }
  if (normalized.includes("shutdown")) {
    return "broadcast_interrupted";
  }
  return "no_contest";
}

export function sanitizePublicTerminalNotice(
  notice: StreamingTerminalNotice | null,
): StreamingTerminalNotice | null {
  if (!notice) return null;
  return {
    ...notice,
    reason: toPublicCancellationReason(notice.reason),
  };
}

/**
 * Build the only scheduler state allowed onto spectator sockets or public
 * REST/SSE. The persisted competitive snapshot is internal authority: it also
 * contains custody, skill, provider, policy-fingerprint, and free-form planning
 * fields. Spectators receive only the separately validated frozen summary.
 */
export function sanitizePublicStreamingState(
  state: StreamingStateUpdate,
): StreamingStateUpdate {
  const sanitizeAgent = (
    agent: StreamingStateUpdate["cycle"]["agent1"],
  ): StreamingStateUpdate["cycle"]["agent1"] => {
    if (!agent) return null;
    const combatLoadouts: typeof agent.combatLoadouts = {};
    for (const role of ["melee", "ranged", "mage"] as const) {
      const loadout = agent.combatLoadouts[role];
      if (!loadout) continue;
      combatLoadouts[role] = {
        role: loadout.role,
        weaponId: loadout.weaponId,
        arrowsId: loadout.arrowsId,
        shieldId: loadout.shieldId,
        spellId: loadout.spellId,
        ...(loadout.armorIds ? { armorIds: { ...loadout.armorIds } } : {}),
      };
    }
    return {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      hp: agent.hp,
      maxHp: agent.maxHp,
      combatLevel: agent.combatLevel,
      wins: agent.wins,
      losses: agent.losses,
      damageDealtThisFight: agent.damageDealtThisFight,
      highestHit: agent.highestHit,
      attacksLanded: agent.attacksLanded,
      healsUsed: agent.healsUsed,
      equipment: { ...agent.equipment },
      inventory: agent.inventory.map((item) => (item ? { ...item } : null)),
      itemIconPaths: { ...agent.itemIconPaths },
      loadoutFingerprint: agent.loadoutFingerprint,
      availableCombatStyles: [...agent.availableCombatStyles],
      combatLoadouts,
      loadoutFrozen: agent.loadoutFrozen,
      strategySummary: agent.loadoutFrozen
        ? parseStreamingDuelStrategySummary(agent.strategySummary)
        : null,
      prayerPointUnits: agent.prayerPointUnits,
      prayerPoints: agent.prayerPoints,
      prayerMaxPoints: agent.prayerMaxPoints,
      rank: agent.rank,
      headToHeadWins: agent.headToHeadWins,
      headToHeadLosses: agent.headToHeadLosses,
    };
  };

  const agent1 = sanitizeAgent(state.cycle.agent1);
  const agent2 = sanitizeAgent(state.cycle.agent2);
  const parsedPreparation = parseStreamingDuelPreparationSummary(
    state.preparation,
  );
  const preparation =
    state.cycle.phase === "IDLE" &&
    parsedPreparation !== null &&
    agent1 !== null &&
    agent2 !== null &&
    parsedPreparation.agent1.id === agent1.id &&
    parsedPreparation.agent2.id === agent2.id
      ? parsedPreparation
      : null;
  const contestantIds = new Set(
    [agent1?.id, agent2?.id].filter((id): id is string => Boolean(id)),
  );
  const actionObservations = state.cycle.actionObservations
    .map(parseStreamingDuelActionObservation)
    .filter(
      (observation): observation is StreamingDuelActionObservation =>
        observation !== null &&
        observation.cycleId === state.cycle.cycleId &&
        observation.duelId === state.cycle.duelId &&
        contestantIds.has(observation.actorId) &&
        contestantIds.has(observation.opponentId),
    )
    .slice(-STREAMING_DUEL_ACTION_OBSERVATION_LIMIT);
  const sourceArenaPositions = state.cycle.arenaPositions;
  const arenaPositions = hasValidStreamingGuardrailArenaPositions(
    sourceArenaPositions,
  )
    ? {
        agent1: [...sourceArenaPositions.agent1] as [number, number, number],
        agent2: [...sourceArenaPositions.agent2] as [number, number, number],
      }
    : null;

  return {
    type: "STREAMING_STATE_UPDATE",
    cycle: {
      cycleId: state.cycle.cycleId,
      phase: state.cycle.phase,
      cycleStartTime: state.cycle.cycleStartTime,
      phaseStartTime: state.cycle.phaseStartTime,
      phaseEndTime: state.cycle.phaseEndTime,
      phaseVersion: state.cycle.phaseVersion,
      timeRemaining: state.cycle.timeRemaining,
      agent1,
      agent2,
      duelId: state.cycle.duelId,
      duelKeyHex: state.cycle.duelKeyHex,
      competitiveSnapshotVersion: state.cycle.competitiveSnapshotVersion,
      competitiveSnapshotDigest: state.cycle.competitiveSnapshotDigest,
      competitiveSnapshot: null,
      betOpenTime: state.cycle.betOpenTime,
      betCloseTime: state.cycle.betCloseTime,
      countdown: state.cycle.countdown,
      fightStartTime: state.cycle.fightStartTime,
      firstHitAt: state.cycle.firstHitAt,
      duelEndTime: state.cycle.duelEndTime,
      arenaPositions,
      winnerId: state.cycle.winnerId,
      winnerName: state.cycle.winnerName,
      outcome: state.cycle.outcome,
      winReason: state.cycle.winReason,
      seed: state.cycle.seed,
      replayHash: state.cycle.replayHash,
      actionObservations,
    },
    leaderboard: state.leaderboard.map((entry) => ({
      rank: entry.rank,
      characterId: entry.characterId,
      name: entry.name,
      provider: entry.provider,
      model: entry.model,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.draws,
      winRate: entry.winRate,
      combatLevel: entry.combatLevel,
      currentStreak: entry.currentStreak,
    })),
    cameraTarget: state.cameraTarget,
    terminalNotice: sanitizePublicTerminalNotice(state.terminalNotice),
    preparation,
  };
}

export function sanitizePublicRecentDuel(
  duel: RecentDuelEntry,
): RecentDuelEntry {
  if (duel.outcome !== "cancelled" || !duel.cancellationReason) return duel;
  return {
    ...duel,
    cancellationReason: toPublicCancellationReason(duel.cancellationReason),
  };
}

export function sanitizePublicOperationalMetrics(
  metrics: StreamingDuelOperationalMetrics,
): StreamingDuelOperationalMetrics {
  const cancellationReasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(
    metrics.historyWindow.cancellationReasons,
  )) {
    const publicReason = toPublicCancellationReason(reason);
    cancellationReasons[publicReason] =
      (cancellationReasons[publicReason] ?? 0) + count;
  }
  return {
    ...metrics,
    historyWindow: {
      ...metrics.historyWindow,
      cancellationReasons,
    },
  };
}
