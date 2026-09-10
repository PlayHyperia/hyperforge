import type {
  StreamingDuelActionObservation,
  StreamingDuelPublicCombatRole,
  StreamingDuelPublicPrayer,
  StreamingDuelPublicStyle,
  StreamingDuelPublicTacticalMacro,
} from "@hyperforge/shared";

type ActionAdmissionCounts = Readonly<{
  attempts: number;
  accepted: number;
  rejected: number;
  errors: number;
}>;

export type CompetitiveExecutionChoiceSummary = Readonly<{
  observations: number;
  movement: ActionAdmissionCounts;
  engagement: ActionAdmissionCounts &
    Readonly<{
      initialAccepted: number;
      keepAliveAccepted: number;
    }>;
  food: Readonly<{
    attempts: number;
    committed: number;
    deferred: number;
    rejected: number;
    errors: number;
    totalHealing: number;
  }>;
  prayer: Readonly<{
    attempts: number;
    committed: number;
    rejected: number;
    errors: number;
    committedByPrayer: Readonly<Record<StreamingDuelPublicPrayer, number>>;
  }>;
  style: Readonly<{
    attempts: number;
    accepted: number;
    rejected: number;
    errors: number;
    acceptedByStyle: Readonly<Record<StreamingDuelPublicStyle, number>>;
  }>;
  roleSwitch: Readonly<{
    attempts: number;
    committed: number;
    deferred: number;
    rejected: number;
    errors: number;
    committedByTargetRole: Readonly<
      Record<StreamingDuelPublicCombatRole, number>
    >;
  }>;
  damage: Readonly<{
    hits: number;
    total: number;
  }>;
  observedCombatRoles: Readonly<Record<StreamingDuelPublicCombatRole, number>>;
  observedTacticalMacros: Readonly<
    Record<StreamingDuelPublicTacticalMacro, number>
  >;
}>;

type MutableSummary = {
  observations: number;
  movement: {
    attempts: number;
    accepted: number;
    rejected: number;
    errors: number;
  };
  engagement: {
    attempts: number;
    accepted: number;
    rejected: number;
    errors: number;
    initialAccepted: number;
    keepAliveAccepted: number;
  };
  food: {
    attempts: number;
    committed: number;
    deferred: number;
    rejected: number;
    errors: number;
    totalHealing: number;
  };
  prayer: {
    attempts: number;
    committed: number;
    rejected: number;
    errors: number;
    committedByPrayer: Record<StreamingDuelPublicPrayer, number>;
  };
  style: {
    attempts: number;
    accepted: number;
    rejected: number;
    errors: number;
    acceptedByStyle: Record<StreamingDuelPublicStyle, number>;
  };
  roleSwitch: {
    attempts: number;
    committed: number;
    deferred: number;
    rejected: number;
    errors: number;
    committedByTargetRole: Record<StreamingDuelPublicCombatRole, number>;
  };
  damage: { hits: number; total: number };
  observedCombatRoles: Record<StreamingDuelPublicCombatRole, number>;
  observedTacticalMacros: Record<StreamingDuelPublicTacticalMacro, number>;
};

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(
      `Competitive execution ${field} exceeds safe integer range`,
    );
  }
  return result;
}

const createMutableSummary = (): MutableSummary => ({
  observations: 0,
  movement: { attempts: 0, accepted: 0, rejected: 0, errors: 0 },
  engagement: {
    attempts: 0,
    accepted: 0,
    rejected: 0,
    errors: 0,
    initialAccepted: 0,
    keepAliveAccepted: 0,
  },
  food: {
    attempts: 0,
    committed: 0,
    deferred: 0,
    rejected: 0,
    errors: 0,
    totalHealing: 0,
  },
  prayer: {
    attempts: 0,
    committed: 0,
    rejected: 0,
    errors: 0,
    committedByPrayer: {
      superhuman_strength: 0,
      rock_skin: 0,
      hawk_eye: 0,
      mystic_lore: 0,
    },
  },
  style: {
    attempts: 0,
    accepted: 0,
    rejected: 0,
    errors: 0,
    acceptedByStyle: {
      accurate: 0,
      aggressive: 0,
      controlled: 0,
      defensive: 0,
      longrange: 0,
      rapid: 0,
    },
  },
  roleSwitch: {
    attempts: 0,
    committed: 0,
    deferred: 0,
    rejected: 0,
    errors: 0,
    committedByTargetRole: { melee: 0, ranged: 0, mage: 0 },
  },
  damage: { hits: 0, total: 0 },
  observedCombatRoles: { melee: 0, ranged: 0, mage: 0 },
  observedTacticalMacros: {
    pressure: 0,
    hold_range: 0,
    kite: 0,
    orbit: 0,
    defensive_reset: 0,
    finish: 0,
  },
});

function freezeSummary(
  summary: MutableSummary,
): CompetitiveExecutionChoiceSummary {
  return Object.freeze({
    observations: summary.observations,
    movement: Object.freeze({ ...summary.movement }),
    engagement: Object.freeze({ ...summary.engagement }),
    food: Object.freeze({ ...summary.food }),
    prayer: Object.freeze({
      ...summary.prayer,
      committedByPrayer: Object.freeze({ ...summary.prayer.committedByPrayer }),
    }),
    style: Object.freeze({
      ...summary.style,
      acceptedByStyle: Object.freeze({ ...summary.style.acceptedByStyle }),
    }),
    roleSwitch: Object.freeze({
      ...summary.roleSwitch,
      committedByTargetRole: Object.freeze({
        ...summary.roleSwitch.committedByTargetRole,
      }),
    }),
    damage: Object.freeze({ ...summary.damage }),
    observedCombatRoles: Object.freeze({ ...summary.observedCombatRoles }),
    observedTacticalMacros: Object.freeze({
      ...summary.observedTacticalMacros,
    }),
  });
}

export function emptyCompetitiveExecutionChoiceSummary(): CompetitiveExecutionChoiceSummary {
  return freezeSummary(createMutableSummary());
}

function increment(
  object: object,
  key: string,
  field: string,
  amount = 1,
): void {
  const values = object as Record<string, unknown>;
  const current = values[key];
  if (typeof current !== "number") {
    throw new Error(`Competitive execution ${field} is not numeric`);
  }
  values[key] = safeAdd(current, amount, field);
}

/** Summarize exact public receipts for one participant without adding inference. */
export function summarizeCompetitiveExecutionChoices(
  observations: readonly StreamingDuelActionObservation[],
  agentId: string,
): CompetitiveExecutionChoiceSummary {
  const summary = createMutableSummary();
  for (const observation of observations) {
    if (observation.actorId !== agentId) continue;
    summary.observations = safeAdd(
      summary.observations,
      1,
      "observation count",
    );
    increment(
      summary.observedCombatRoles,
      observation.combatRole,
      "combat-role observation count",
    );
    increment(
      summary.observedTacticalMacros,
      observation.tacticalMacro,
      "tactical-macro observation count",
    );

    switch (observation.action) {
      case "movement":
        summary.movement.attempts = safeAdd(
          summary.movement.attempts,
          1,
          "movement attempt count",
        );
        increment(
          summary.movement,
          observation.outcome === "error" ? "errors" : observation.outcome,
          "movement outcome count",
        );
        break;
      case "engagement":
        summary.engagement.attempts = safeAdd(
          summary.engagement.attempts,
          1,
          "engagement attempt count",
        );
        increment(
          summary.engagement,
          observation.outcome === "error" ? "errors" : observation.outcome,
          "engagement outcome count",
        );
        if (observation.outcome === "accepted") {
          increment(
            summary.engagement,
            observation.value === "initial"
              ? "initialAccepted"
              : "keepAliveAccepted",
            "engagement acceptance-kind count",
          );
        }
        break;
      case "food":
        summary.food.attempts = safeAdd(
          summary.food.attempts,
          1,
          "food attempt count",
        );
        increment(
          summary.food,
          observation.outcome === "error" ? "errors" : observation.outcome,
          "food outcome count",
        );
        if (observation.outcome === "committed") {
          summary.food.totalHealing = safeAdd(
            summary.food.totalHealing,
            observation.amount,
            "food healing",
          );
        }
        break;
      case "prayer":
        summary.prayer.attempts = safeAdd(
          summary.prayer.attempts,
          1,
          "prayer attempt count",
        );
        increment(
          summary.prayer,
          observation.outcome === "error" ? "errors" : observation.outcome,
          "prayer outcome count",
        );
        if (observation.outcome === "committed") {
          increment(
            summary.prayer.committedByPrayer,
            observation.value,
            "prayer commit count",
          );
        }
        break;
      case "style":
        summary.style.attempts = safeAdd(
          summary.style.attempts,
          1,
          "style attempt count",
        );
        increment(
          summary.style,
          observation.outcome === "error" ? "errors" : observation.outcome,
          "style outcome count",
        );
        if (observation.outcome === "accepted") {
          increment(
            summary.style.acceptedByStyle,
            observation.value,
            "style acceptance count",
          );
        }
        break;
      case "role_switch":
        summary.roleSwitch.attempts = safeAdd(
          summary.roleSwitch.attempts,
          1,
          "role-switch attempt count",
        );
        increment(
          summary.roleSwitch,
          observation.outcome === "error" ? "errors" : observation.outcome,
          "role-switch outcome count",
        );
        if (observation.outcome === "committed") {
          increment(
            summary.roleSwitch.committedByTargetRole,
            observation.value,
            "role-switch commit count",
          );
        }
        break;
      case "damage":
        summary.damage.hits = safeAdd(
          summary.damage.hits,
          1,
          "damage hit count",
        );
        summary.damage.total = safeAdd(
          summary.damage.total,
          observation.amount,
          "damage total",
        );
        break;
    }
  }
  return freezeSummary(summary);
}

function mergeRecord<T extends string>(
  target: Record<T, number>,
  source: Readonly<Record<T, number>>,
  field: string,
): void {
  for (const key of Object.keys(target) as T[]) {
    target[key] = safeAdd(target[key], source[key], field);
  }
}

/** Add summaries exactly for population aggregation; no rate or score is inferred. */
export function mergeCompetitiveExecutionChoiceSummaries(
  left: CompetitiveExecutionChoiceSummary,
  right: CompetitiveExecutionChoiceSummary,
): CompetitiveExecutionChoiceSummary {
  const merged = createMutableSummary();
  const addFlat = (
    target: object,
    leftValues: object,
    rightValues: object,
    excluded: ReadonlySet<string> = new Set(),
  ) => {
    const targetRecord = target as Record<string, unknown>;
    const leftRecord = leftValues as Record<string, unknown>;
    const rightRecord = rightValues as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      if (excluded.has(key)) continue;
      const leftValue = leftRecord[key];
      const rightValue = rightRecord[key];
      if (typeof leftValue !== "number" || typeof rightValue !== "number") {
        throw new Error(`Competitive execution ${key} count is not numeric`);
      }
      targetRecord[key] = safeAdd(leftValue, rightValue, `${key} count`);
    }
  };

  merged.observations = safeAdd(
    left.observations,
    right.observations,
    "observation count",
  );
  addFlat(merged.movement, left.movement, right.movement);
  addFlat(merged.engagement, left.engagement, right.engagement);
  addFlat(merged.food, left.food, right.food);
  addFlat(
    merged.prayer,
    left.prayer,
    right.prayer,
    new Set(["committedByPrayer"]),
  );
  mergeRecord(
    merged.prayer.committedByPrayer,
    left.prayer.committedByPrayer,
    "prayer commit count",
  );
  mergeRecord(
    merged.prayer.committedByPrayer,
    right.prayer.committedByPrayer,
    "prayer commit count",
  );
  addFlat(merged.style, left.style, right.style, new Set(["acceptedByStyle"]));
  mergeRecord(
    merged.style.acceptedByStyle,
    left.style.acceptedByStyle,
    "style acceptance count",
  );
  mergeRecord(
    merged.style.acceptedByStyle,
    right.style.acceptedByStyle,
    "style acceptance count",
  );
  addFlat(
    merged.roleSwitch,
    left.roleSwitch,
    right.roleSwitch,
    new Set(["committedByTargetRole"]),
  );
  mergeRecord(
    merged.roleSwitch.committedByTargetRole,
    left.roleSwitch.committedByTargetRole,
    "role-switch commit count",
  );
  mergeRecord(
    merged.roleSwitch.committedByTargetRole,
    right.roleSwitch.committedByTargetRole,
    "role-switch commit count",
  );
  addFlat(merged.damage, left.damage, right.damage);
  mergeRecord(
    merged.observedCombatRoles,
    left.observedCombatRoles,
    "combat-role observation count",
  );
  mergeRecord(
    merged.observedCombatRoles,
    right.observedCombatRoles,
    "combat-role observation count",
  );
  mergeRecord(
    merged.observedTacticalMacros,
    left.observedTacticalMacros,
    "tactical-macro observation count",
  );
  mergeRecord(
    merged.observedTacticalMacros,
    right.observedTacticalMacros,
    "tactical-macro observation count",
  );
  return freezeSummary(merged);
}
