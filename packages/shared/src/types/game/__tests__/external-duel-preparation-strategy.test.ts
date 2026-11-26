import { describe, expect, it } from "vitest";

import {
  DUEL_PREPARATION_ROLE_POLICY_VERSION,
  EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
  normalizeExternalDuelPreparationPlanStrategyDecision,
  normalizeExternalDuelPreparationOpponentHistorySummary,
  normalizeExternalDuelPreparationPublicName,
  normalizeExternalDuelPreparationPublicProfile,
  normalizeExternalDuelPreparationStrategyDecision,
  normalizeExternalDuelPreparationStrategyRequest,
  normalizeExternalDuelPreparationStrategyResponse,
} from "../external-duel-preparation-strategy";

const request = {
  requestId: "11111111-1111-4111-8111-111111111111",
  preparationId: "22222222-2222-4222-8222-222222222222",
  policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
  protocolVersion: EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
  expiresAt: 20_000,
  decisionDeadlineAt: 10_000,
  agentName: "Agent",
  opponentName: "Opponent",
  ownPublicProfile: { narrative: "Patient.", pillars: ["adaptive"] },
  opponentPublicProfile: null,
  opponentHistorySummary: {
    sampleSize: 2,
    observedOpponentOpeningStyleFocus: "ranged",
    recent: [
      {
        result: "loss",
        ownOpeningStyle: "melee",
        opponentOpeningStyle: "ranged",
        winReason: "kill",
      },
      {
        result: "win",
        ownOpeningStyle: "ranged",
        opponentOpeningStyle: "mage",
        winReason: "hp_advantage",
      },
    ],
  },
  availableRoles: ["melee", "ranged"],
  availablePrayerIds: [],
  preparationOptions: [
    {
      planOptionId: "33333333-3333-4333-8333-333333333333",
      primaryStyle: "melee",
      styleRank: 1,
      attackSupplyUnits: null,
      canUseShield: true,
    },
    {
      planOptionId: "44444444-4444-4444-8444-444444444444",
      primaryStyle: "ranged",
      styleRank: 1,
      attackSupplyUnits: 20,
      canUseShield: false,
    },
  ],
  foodOptions: [
    {
      foodOptionId: "55555555-5555-4555-8555-555555555555",
      recoveryRank: 1,
      quantity: 4,
    },
    {
      foodOptionId: "66666666-6666-4666-8666-666666666666",
      recoveryRank: 2,
      quantity: 3,
    },
  ],
  armorOptions: [
    {
      armorOptionId: "77777777-7777-4777-8777-777777777777",
      planOptionId: "33333333-3333-4333-8333-333333333333",
      offenseRank: 1,
      focusedDefenseRank: null,
      totalDefenseRank: 2,
    },
    {
      armorOptionId: "88888888-8888-4888-8888-888888888888",
      planOptionId: "33333333-3333-4333-8333-333333333333",
      offenseRank: 2,
      focusedDefenseRank: null,
      totalDefenseRank: 1,
    },
    {
      armorOptionId: "99999999-9999-4999-8999-999999999999",
      planOptionId: "44444444-4444-4444-8444-444444444444",
      offenseRank: 1,
      focusedDefenseRank: null,
      totalDefenseRank: 1,
    },
  ],
  deterministicPlanOptionId: "33333333-3333-4333-8333-333333333333",
  deterministicFoodOptionId: "55555555-5555-4555-8555-555555555555",
  deterministicArmorOptionId: "77777777-7777-4777-8777-777777777777",
  deterministicRole: "melee",
} as const;

const boundedDecision = {
  primaryStyle: "ranged",
  reason: "Open at range and adapt.",
  tacticalStrategy: {
    approach: "balanced",
    tacticalMacro: "kite",
    attackStyle: "accurate",
    prayer: null,
    preferredCombatRole: "ranged",
    foodThreshold: 40,
    switchDefensiveAt: 30,
    reasoning: "Preserve distance until finishing pressure is safe.",
  },
} as const;
const decision = {
  armorOptionId: "99999999-9999-4999-8999-999999999999",
  planOptionId: "44444444-4444-4444-8444-444444444444",
  foodOptionId: "66666666-6666-4666-8666-666666666666",
  ...boundedDecision,
} as const;

describe("external duel preparation strategy contract", () => {
  it("accepts one exact bounded request with no Prayer choices", () => {
    expect(normalizeExternalDuelPreparationStrategyRequest(request)).toEqual(
      request,
    );
  });

  it("rejects extra authority, duplicate roles, and invalid deadlines", () => {
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        bankItems: ["private"],
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationOpponentHistorySummary({
        sampleSize: 9,
        observedOpponentOpeningStyleFocus: "melee",
        recent: Array.from({ length: 9 }, () => ({
          result: "win",
          ownOpeningStyle: "ranged",
          opponentOpeningStyle: "melee",
          winReason: "kill",
        })),
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        deterministicPlanOptionId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        availableRoles: ["melee", "melee"],
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        decisionDeadlineAt: request.expiresAt,
      }),
    ).toBeNull();
  });

  it("normalizes hostile public text without admitting instructions", () => {
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        agentName: "Agent\n\u202eDROP_ALL",
      })?.agentName,
    ).toBe("Agent DROP_ALL");
    expect(
      normalizeExternalDuelPreparationPublicName(
        "  Agent\u061c\u200e\u202e\nName  ",
      ),
    ).toBe("Agent Name");
    expect(
      normalizeExternalDuelPreparationPublicProfile({
        narrative: "  Patient\u2066\nplanner.  ",
        pillars: [" adaptive ", "ranged\u200f control"],
      }),
    ).toEqual({
      narrative: "Patient planner.",
      pillars: ["adaptive", "ranged control"],
    });
    expect(
      normalizeExternalDuelPreparationPublicProfile({
        narrative: "Patient.",
        pillars: ["adaptive"],
        privateBank: true,
      }),
    ).toBeNull();
  });

  it("accepts only the bounded identifier-free verified matchup summary", () => {
    expect(
      normalizeExternalDuelPreparationOpponentHistorySummary({
        sampleSize: 0,
        observedOpponentOpeningStyleFocus: null,
        recent: [],
      }),
    ).toEqual({
      sampleSize: 0,
      observedOpponentOpeningStyleFocus: null,
      recent: [],
    });
    expect(
      normalizeExternalDuelPreparationOpponentHistorySummary({
        sampleSize: 2,
        observedOpponentOpeningStyleFocus: "mage",
        recent: [
          {
            result: "win",
            ownOpeningStyle: "ranged",
            opponentOpeningStyle: "mage",
            winReason: "kill",
          },
          {
            result: "loss",
            ownOpeningStyle: "mage",
            opponentOpeningStyle: "ranged",
            winReason: "forfeit",
          },
        ],
      }),
    ).toMatchObject({ observedOpponentOpeningStyleFocus: "mage" });
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        opponentHistorySummary: {
          ...request.opponentHistorySummary,
          recent: request.opponentHistorySummary.recent.map((entry, index) =>
            index === 0 ? { ...entry, cycleId: "private-cycle" } : entry,
          ),
        },
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        opponentHistorySummary: {
          ...request.opponentHistorySummary,
          observedOpponentOpeningStyleFocus: "mage",
        },
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        opponentHistorySummary: {
          ...request.opponentHistorySummary,
          sampleSize: 3,
        },
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        opponentHistorySummary: {
          sampleSize: 1,
          observedOpponentOpeningStyleFocus: "ranged",
          recent: [
            {
              result: "draw",
              ownOpeningStyle: "melee",
              opponentOpeningStyle: "ranged",
              winReason: "kill",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("admits two owned plan choices within one combat style", () => {
    const sameStyleRequest = {
      ...request,
      availableRoles: ["melee"],
      preparationOptions: [
        request.preparationOptions[0],
        {
          ...request.preparationOptions[0],
          planOptionId: "55555555-5555-4555-8555-555555555555",
          styleRank: 2,
        },
      ],
      armorOptions: [
        request.armorOptions[0],
        request.armorOptions[1],
        {
          ...request.armorOptions[2],
          planOptionId: "55555555-5555-4555-8555-555555555555",
        },
      ],
    } as const;
    expect(
      normalizeExternalDuelPreparationStrategyRequest(sameStyleRequest),
    ).toEqual(sameStyleRequest);
  });

  it("accepts only a complete allowlisted decision", () => {
    expect(
      normalizeExternalDuelPreparationStrategyDecision(
        boundedDecision,
        request.availableRoles,
        request.availablePrayerIds,
      ),
    ).toEqual(boundedDecision);
    expect(
      normalizeExternalDuelPreparationStrategyDecision(
        { ...boundedDecision, itemId: "private-bank-item" },
        request.availableRoles,
        request.availablePrayerIds,
      ),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyDecision(
        { ...boundedDecision, primaryStyle: "mage" },
        request.availableRoles,
        request.availablePrayerIds,
      ),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationPlanStrategyDecision(
        decision,
        request.preparationOptions,
        request.foodOptions,
        request.armorOptions,
        request.availablePrayerIds,
      ),
    ).toEqual(decision);
    expect(
      normalizeExternalDuelPreparationPlanStrategyDecision(
        { ...decision, primaryStyle: "melee" },
        request.preparationOptions,
        request.foodOptions,
        request.armorOptions,
        request.availablePrayerIds,
      ),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationPlanStrategyDecision(
        {
          ...decision,
          foodOptionId: "77777777-7777-4777-8777-777777777777",
        },
        request.preparationOptions,
        request.foodOptions,
        request.armorOptions,
        request.availablePrayerIds,
      ),
    ).toBeNull();
  });

  it("requires complete plan-scoped armor ranks without admitting private equipment data", () => {
    expect(
      normalizeExternalDuelPreparationPlanStrategyDecision(
        {
          ...decision,
          armorOptionId: request.armorOptions[0].armorOptionId,
        },
        request.preparationOptions,
        request.foodOptions,
        request.armorOptions,
        request.availablePrayerIds,
      ),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        deterministicArmorOptionId: request.armorOptions[1].armorOptionId,
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        armorOptions: request.armorOptions.map((option, index) =>
          index === 1 ? { ...option, offenseRank: 1 } : option,
        ),
      }),
    ).toBeNull();
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        armorOptions: [
          { ...request.armorOptions[0], itemId: "private-armor" },
          ...request.armorOptions.slice(1),
        ],
      }),
    ).toBeNull();
  });

  it("requires selected decisions and null fallback decisions", () => {
    expect(
      normalizeExternalDuelPreparationStrategyResponse(
        {
          requestId: request.requestId,
          preparationId: request.preparationId,
          status: "selected",
          decision,
        },
        request.preparationOptions,
        request.foodOptions,
        request.armorOptions,
        request.availablePrayerIds,
      ),
    ).toEqual({
      requestId: request.requestId,
      preparationId: request.preparationId,
      status: "selected",
      decision,
    });
    expect(
      normalizeExternalDuelPreparationStrategyResponse(
        {
          requestId: request.requestId,
          preparationId: request.preparationId,
          status: "fallback",
          decision,
        },
        request.preparationOptions,
        request.foodOptions,
        request.armorOptions,
        request.availablePrayerIds,
      ),
    ).toBeNull();
  });

  it("requires null food selection only when no owned food option exists", () => {
    const noFoodRequest = {
      ...request,
      foodOptions: [],
      deterministicFoodOptionId: null,
    } as const;
    expect(
      normalizeExternalDuelPreparationStrategyRequest(noFoodRequest),
    ).toEqual(noFoodRequest);
    expect(
      normalizeExternalDuelPreparationPlanStrategyDecision(
        { ...decision, foodOptionId: null },
        noFoodRequest.preparationOptions,
        noFoodRequest.foodOptions,
        noFoodRequest.armorOptions,
        noFoodRequest.availablePrayerIds,
      ),
    ).toEqual({ ...decision, foodOptionId: null });
    expect(
      normalizeExternalDuelPreparationStrategyRequest({
        ...request,
        foodOptions: [
          request.foodOptions[0],
          { ...request.foodOptions[1], recoveryRank: 1 },
        ],
      }),
    ).toBeNull();
  });
});
