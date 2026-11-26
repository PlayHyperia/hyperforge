import { describe, expect, it } from "vitest";

import type { StreamingDuelActionObservation } from "@hyperforge/shared";

import {
  mergeCompetitiveExecutionChoiceSummaries,
  summarizeCompetitiveExecutionChoices,
} from "../competitive-execution-choice-metrics.js";

const base = {
  schemaVersion: 1,
  tick: 1,
  observedAt: 1_000,
  cycleId: "execution-cycle",
  duelId: "execution-duel",
  actorId: "agent-a",
  opponentId: "agent-b",
  phase: "FIGHTING",
  combatRole: "melee",
  tacticalMacro: "kite",
} as const;

const observations: StreamingDuelActionObservation[] = [
  {
    ...base,
    sequence: 1,
    action: "movement",
    outcome: "accepted",
    value: "reposition",
    amount: null,
  },
  {
    ...base,
    sequence: 2,
    action: "engagement",
    outcome: "rejected",
    value: "initial",
    amount: null,
  },
  {
    ...base,
    sequence: 3,
    action: "engagement",
    outcome: "accepted",
    value: "keep_alive",
    amount: null,
  },
  {
    ...base,
    sequence: 4,
    action: "food",
    outcome: "deferred",
    value: "disengage",
    amount: null,
  },
  {
    ...base,
    sequence: 5,
    action: "food",
    outcome: "committed",
    value: "consume",
    amount: 5,
  },
  {
    ...base,
    sequence: 6,
    action: "prayer",
    outcome: "committed",
    value: "hawk_eye",
    amount: null,
  },
  {
    ...base,
    sequence: 7,
    action: "prayer",
    outcome: "error",
    value: "rock_skin",
    amount: null,
  },
  {
    ...base,
    sequence: 8,
    action: "style",
    outcome: "accepted",
    value: "rapid",
    amount: null,
  },
  {
    ...base,
    sequence: 9,
    action: "style",
    outcome: "rejected",
    value: "defensive",
    amount: null,
  },
  {
    ...base,
    sequence: 10,
    action: "role_switch",
    outcome: "deferred",
    value: "ranged",
    amount: null,
  },
  {
    ...base,
    sequence: 11,
    action: "role_switch",
    outcome: "committed",
    value: "ranged",
    amount: null,
  },
  {
    ...base,
    sequence: 12,
    combatRole: "ranged",
    tacticalMacro: "finish",
    action: "damage",
    outcome: "committed",
    value: "hit",
    amount: 7,
  },
  {
    ...base,
    sequence: 13,
    actorId: "agent-b",
    opponentId: "agent-a",
    action: "damage",
    outcome: "committed",
    value: "hit",
    amount: 3,
  },
];

describe("competitive execution choice metrics", () => {
  it("summarizes exact public actions for one participant", () => {
    const summary = summarizeCompetitiveExecutionChoices(
      observations,
      "agent-a",
    );

    expect(summary).toMatchObject({
      observations: 12,
      movement: { attempts: 1, accepted: 1, rejected: 0, errors: 0 },
      engagement: {
        attempts: 2,
        accepted: 1,
        rejected: 1,
        errors: 0,
        initialAccepted: 0,
        keepAliveAccepted: 1,
      },
      food: {
        attempts: 2,
        committed: 1,
        deferred: 1,
        rejected: 0,
        errors: 0,
        totalHealing: 5,
      },
      prayer: {
        attempts: 2,
        committed: 1,
        rejected: 0,
        errors: 1,
        committedByPrayer: { hawk_eye: 1, rock_skin: 0 },
      },
      style: {
        attempts: 2,
        accepted: 1,
        rejected: 1,
        errors: 0,
        acceptedByStyle: { rapid: 1, defensive: 0 },
      },
      roleSwitch: {
        attempts: 2,
        committed: 1,
        deferred: 1,
        rejected: 0,
        errors: 0,
        committedByTargetRole: { melee: 0, ranged: 1, mage: 0 },
      },
      damage: { hits: 1, total: 7 },
      observedCombatRoles: { melee: 11, ranged: 1, mage: 0 },
      observedTacticalMacros: { kite: 11, finish: 1 },
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.roleSwitch.committedByTargetRole)).toBe(
      true,
    );
  });

  it("merges population counts without inventing rates or scores", () => {
    const summary = summarizeCompetitiveExecutionChoices(
      observations,
      "agent-a",
    );
    const merged = mergeCompetitiveExecutionChoiceSummaries(summary, summary);

    expect(merged).toMatchObject({
      observations: 24,
      movement: { attempts: 2, accepted: 2 },
      engagement: { attempts: 4, accepted: 2, rejected: 2 },
      food: { attempts: 4, committed: 2, deferred: 2, totalHealing: 10 },
      prayer: { attempts: 4, committed: 2, errors: 2 },
      style: { attempts: 4, accepted: 2, rejected: 2 },
      roleSwitch: { attempts: 4, committed: 2, deferred: 2 },
      damage: { hits: 2, total: 14 },
      observedCombatRoles: { melee: 22, ranged: 2, mage: 0 },
      observedTacticalMacros: { kite: 22, finish: 2 },
    });
    expect(Object.isFrozen(merged)).toBe(true);
  });
});
