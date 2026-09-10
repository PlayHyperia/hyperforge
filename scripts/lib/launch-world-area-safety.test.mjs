import assert from "node:assert/strict";
import { test } from "node:test";

import { validateLaunchWorldAreaSafety } from "./launch-world-area-safety.mjs";

const diagnosticPrivateCustody = () => ({
  version: 1,
  mode: "private_grave",
  approvalStatus: "diagnostic_only",
  keptItemCount: 3,
  ownerProtectionTicks: null,
  publicTransitionTicks: null,
  terminalExpirationTicks: null,
  spectatorCopyKey: "death_custody.preparation_private_grave",
});

const documentWith = (level1Areas) => ({
  starterTowns: {
    central_haven: {
      id: "central_haven",
      safeZone: true,
      pvpEnabled: false,
    },
  },
  level1Areas,
  level2Areas: {},
  level3Areas: {},
  specialAreas: {
    duel_arena: { id: "duel_arena", safeZone: true, pvpEnabled: false },
  },
});

test("accepts safe areas plus explicitly governed preparation terrain", () => {
  assert.deepEqual(
    validateLaunchWorldAreaSafety(
      documentWith({
        preparation_training_grounds: {
          id: "preparation_training_grounds",
          safeZone: false,
          pvpEnabled: false,
          agentPreparationArea: true,
          deathCustodyPolicy: diagnosticPrivateCustody(),
        },
      }),
    ),
    [],
  );
});

test("rejects missing, public, expiring, or falsely approved preparation custody", () => {
  const result = validateLaunchWorldAreaSafety(
    documentWith({
      missing: {
        id: "missing",
        safeZone: false,
        pvpEnabled: false,
        agentPreparationArea: true,
      },
      public_area: {
        id: "public_area",
        safeZone: false,
        pvpEnabled: false,
        agentPreparationArea: true,
        deathCustodyPolicy: {
          ...diagnosticPrivateCustody(),
          mode: "public_risk",
          publicTransitionTicks: 100,
        },
      },
      false_approval: {
        id: "false_approval",
        safeZone: false,
        pvpEnabled: false,
        agentPreparationArea: true,
        deathCustodyPolicy: {
          ...diagnosticPrivateCustody(),
          approvalStatus: "approved",
        },
      },
    }),
  );

  assert.ok(
    result.includes("missing must declare a preparation death-custody policy"),
  );
  assert.ok(
    result.includes("public_area must use implemented private-grave custody"),
  );
  assert.ok(
    result.includes(
      "public_area.publicTransitionTicks must be null for durable private custody",
    ),
  );
  assert.ok(
    result.includes("false_approval death-custody approval ID is invalid"),
  );
  assert.ok(
    result.includes("false_approval death-custody approval time is invalid"),
  );
});

test("rejects the retired wilderness test area independently of its flags", () => {
  assert.deepEqual(
    validateLaunchWorldAreaSafety(
      documentWith({
        wilderness_test: {
          id: "wilderness_test",
          safeZone: true,
          pvpEnabled: false,
        },
      }),
    ),
    ["world-areas.json must not publish retired area wilderness_test"],
  );
});

test("rejects generic PvP and ungoverned unsafe areas", () => {
  assert.deepEqual(
    validateLaunchWorldAreaSafety(
      documentWith({
        pvp_area: { id: "pvp_area", safeZone: false, pvpEnabled: true },
        unsafe_area: {
          id: "unsafe_area",
          safeZone: false,
          pvpEnabled: false,
        },
      }),
    ),
    [
      "pvp_area must not enable generic PvP in the duel launch manifest",
      "pvp_area must not expose ungoverned public-risk death custody in the duel launch manifest",
      "unsafe_area must not expose ungoverned public-risk death custody in the duel launch manifest",
    ],
  );
});
