import { describe, expect, it } from "vitest";
import {
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  parseStreamingDuelActionObservation,
  parseStreamingDuelDamageObservationContext,
  parseStreamingDuelExecutorObservationContext,
  parseStreamingDuelFoodObservationContext,
  parseStreamingDuelPrayerObservationContext,
  parseStreamingDuelRoleSwitchObservationContext,
  parseStreamingDuelStyleObservationContext,
} from "../streaming-duel-action-observation";

const baseObservation = {
  schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  sequence: 1,
  tick: 4,
  observedAt: 1_725_000_000_000,
  cycleId: "cycle-1",
  duelId: "duel-1",
  actorId: "fighter-a",
  opponentId: "fighter-b",
  phase: "FIGHTING" as const,
  combatRole: "ranged" as const,
  tacticalMacro: "kite" as const,
};

describe("streaming duel public action observations", () => {
  it.each([
    {
      action: "movement",
      outcome: "accepted",
      value: "reposition",
      amount: null,
    },
    {
      action: "engagement",
      outcome: "accepted",
      value: "initial",
      amount: null,
    },
    { action: "food", outcome: "deferred", value: "disengage", amount: null },
    { action: "food", outcome: "committed", value: "consume", amount: 12 },
    { action: "food", outcome: "committed", value: "consume", amount: 0 },
    { action: "prayer", outcome: "committed", value: "hawk_eye", amount: null },
    { action: "style", outcome: "accepted", value: "rapid", amount: null },
    { action: "role_switch", outcome: "deferred", value: "mage", amount: null },
    { action: "damage", outcome: "committed", value: "hit", amount: 14 },
  ] as const)(
    "accepts the exact privacy-safe $action/$outcome shape",
    (actionFields) => {
      const parsed = parseStreamingDuelActionObservation({
        ...baseObservation,
        ...actionFields,
      });

      expect(parsed).toEqual({ ...baseObservation, ...actionFields });
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it.each([
    {
      action: "movement",
      outcome: "committed",
      value: "reposition",
      amount: null,
    },
    {
      action: "engagement",
      outcome: "accepted",
      value: "unknown",
      amount: null,
    },
    { action: "food", outcome: "committed", value: "consume", amount: null },
    { action: "food", outcome: "deferred", value: "consume", amount: 12 },
    {
      action: "prayer",
      outcome: "committed",
      value: "private_prayer",
      amount: null,
    },
    { action: "style", outcome: "deferred", value: "rapid", amount: null },
    {
      action: "role_switch",
      outcome: "committed",
      value: "prayer",
      amount: null,
    },
    { action: "damage", outcome: "accepted", value: "hit", amount: 14 },
    { action: "damage", outcome: "committed", value: "hit", amount: 0 },
  ] as const)(
    "rejects invalid cross-field action semantics for $action/$outcome",
    (actionFields) => {
      expect(
        parseStreamingDuelActionObservation({
          ...baseObservation,
          ...actionFields,
        }),
      ).toBeNull();
    },
  );

  it.each([
    ["reasoning", "secret model reasoning"],
    ["coordinates", [1, 2, 3]],
    ["bank", { itemIds: ["shark"] }],
    ["wallet", "private-wallet"],
    ["rawError", "database transport failed"],
  ] as const)("rejects the extra private field %s", (key, value) => {
    expect(
      parseStreamingDuelActionObservation({
        ...baseObservation,
        action: "movement",
        outcome: "accepted",
        value: "reposition",
        amount: null,
        [key]: value,
      }),
    ).toBeNull();
  });

  it("rejects malformed identities, clocks, sequence values, and public enums", () => {
    const valid = {
      ...baseObservation,
      action: "movement",
      outcome: "accepted",
      value: "reposition",
      amount: null,
    };

    for (const invalid of [
      { ...valid, sequence: 0 },
      { ...valid, tick: -1 },
      { ...valid, observedAt: Number.NaN },
      { ...valid, actorId: "fighter\u0000-a" },
      { ...valid, opponentId: "" },
      { ...valid, phase: "COUNTDOWN" },
      { ...valid, combatRole: "prayer" },
      { ...valid, tacticalMacro: "private_strategy" },
    ]) {
      expect(parseStreamingDuelActionObservation(invalid)).toBeNull();
    }
  });

  it("accepts only an exact frozen atomic food-observation context", () => {
    const context = {
      operationId: "00000000-0000-4000-8000-000000000001",
      tick: baseObservation.tick,
      observedAt: baseObservation.observedAt,
      cycleId: baseObservation.cycleId,
      duelId: baseObservation.duelId,
      actorId: baseObservation.actorId,
      opponentId: baseObservation.opponentId,
      phase: baseObservation.phase,
      combatRole: baseObservation.combatRole,
      tacticalMacro: baseObservation.tacticalMacro,
    };

    const parsed = parseStreamingDuelFoodObservationContext(context);
    expect(parsed).toEqual(context);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseStreamingDuelFoodObservationContext({
        ...context,
        reasoning: "private",
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelFoodObservationContext({
        ...context,
        operationId: "food:not-a-public-observation-uuid",
      }),
    ).toBeNull();
  });

  it("accepts only an exact frozen atomic prayer-observation context", () => {
    const context = {
      operationId: "00000000-0000-4000-8000-000000000002",
      tick: baseObservation.tick,
      observedAt: baseObservation.observedAt,
      cycleId: baseObservation.cycleId,
      duelId: baseObservation.duelId,
      actorId: baseObservation.actorId,
      opponentId: baseObservation.opponentId,
      phase: baseObservation.phase,
      combatRole: baseObservation.combatRole,
      tacticalMacro: baseObservation.tacticalMacro,
      prayer: "hawk_eye" as const,
    };

    const parsed = parseStreamingDuelPrayerObservationContext(context);
    expect(parsed).toEqual(context);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseStreamingDuelPrayerObservationContext({
        ...context,
        bank: { private: true },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPrayerObservationContext({
        ...context,
        prayer: "protect_from_magic",
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPrayerObservationContext({
        ...context,
        operationId: "prayer:not-a-public-observation-uuid",
      }),
    ).toBeNull();
  });

  it("accepts only an exact frozen atomic role-switch context", () => {
    const context = {
      operationId: "00000000-0000-4000-8000-000000000003",
      tick: baseObservation.tick,
      observedAt: baseObservation.observedAt,
      cycleId: baseObservation.cycleId,
      duelId: baseObservation.duelId,
      actorId: baseObservation.actorId,
      opponentId: baseObservation.opponentId,
      phase: baseObservation.phase,
      combatRole: "melee" as const,
      tacticalMacro: baseObservation.tacticalMacro,
      targetRole: "ranged" as const,
    };

    const parsed = parseStreamingDuelRoleSwitchObservationContext(context);
    expect(parsed).toEqual(context);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseStreamingDuelRoleSwitchObservationContext({
        ...context,
        inventory: ["private"],
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelRoleSwitchObservationContext({
        ...context,
        targetRole: "prayer",
      }),
    ).toBeNull();
  });

  it("accepts only an exact frozen atomic damage context", () => {
    const context = {
      operationId: "00000000-0000-4000-8000-000000000004",
      tick: baseObservation.tick,
      observedAt: baseObservation.observedAt,
      cycleId: baseObservation.cycleId,
      duelId: baseObservation.duelId,
      actorId: baseObservation.actorId,
      opponentId: baseObservation.opponentId,
      phase: baseObservation.phase,
      combatRole: "mage" as const,
      tacticalMacro: baseObservation.tacticalMacro,
      requestedDamage: 9,
    };

    const parsed = parseStreamingDuelDamageObservationContext(context);
    expect(parsed).toEqual(context);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseStreamingDuelDamageObservationContext({
        ...context,
        requestedDamage: 0,
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelDamageObservationContext({
        ...context,
        wallet: "private",
      }),
    ).toBeNull();
  });

  it("accepts only an exact frozen atomic style context", () => {
    const context = {
      operationId: "00000000-0000-4000-8000-000000000005",
      tick: baseObservation.tick,
      observedAt: baseObservation.observedAt,
      cycleId: baseObservation.cycleId,
      duelId: baseObservation.duelId,
      actorId: baseObservation.actorId,
      opponentId: baseObservation.opponentId,
      phase: baseObservation.phase,
      combatRole: "ranged" as const,
      tacticalMacro: baseObservation.tacticalMacro,
      style: "rapid" as const,
    };

    const parsed = parseStreamingDuelStyleObservationContext(context);
    expect(parsed).toEqual(context);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseStreamingDuelStyleObservationContext({
        ...context,
        reasoning: "private",
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelStyleObservationContext({
        ...context,
        style: "longrange",
      }),
    ).toEqual({ ...context, style: "longrange" });
    expect(
      parseStreamingDuelStyleObservationContext({
        ...context,
        style: "autocast",
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelStyleObservationContext({
        ...context,
        operationId: "style:not-a-public-observation-uuid",
      }),
    ).toBeNull();
  });

  it("accepts only exact frozen movement and engagement command contexts", () => {
    const movement = {
      operationId: "00000000-0000-4000-8000-000000000006",
      tick: baseObservation.tick,
      observedAt: baseObservation.observedAt,
      cycleId: baseObservation.cycleId,
      duelId: baseObservation.duelId,
      actorId: baseObservation.actorId,
      opponentId: baseObservation.opponentId,
      phase: baseObservation.phase,
      combatRole: baseObservation.combatRole,
      tacticalMacro: baseObservation.tacticalMacro,
      action: "movement" as const,
      value: "reposition" as const,
    };
    const engagement = {
      ...movement,
      operationId: "00000000-0000-4000-8000-000000000007",
      action: "engagement" as const,
      value: "keep_alive" as const,
    };

    expect(parseStreamingDuelExecutorObservationContext(movement)).toEqual(
      movement,
    );
    expect(parseStreamingDuelExecutorObservationContext(engagement)).toEqual(
      engagement,
    );
    expect(
      Object.isFrozen(parseStreamingDuelExecutorObservationContext(movement)),
    ).toBe(true);
    expect(
      parseStreamingDuelExecutorObservationContext({
        ...movement,
        coordinates: [1, 2, 3],
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelExecutorObservationContext({
        ...movement,
        value: "initial",
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelExecutorObservationContext({
        ...engagement,
        value: "reposition",
      }),
    ).toBeNull();
  });
});
