const AREA_GROUPS = [
  "starterTowns",
  "level1Areas",
  "level2Areas",
  "level3Areas",
  "specialAreas",
];
const SAFE_COPY_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SAFE_APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function validatePreparationPolicy(areaId, policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [`${areaId} must declare a preparation death-custody policy`];
  }
  const failures = [];
  if (policy.version !== 1) {
    failures.push(`${areaId} has an unsupported death-custody version`);
  }
  if (policy.mode !== "private_grave") {
    failures.push(`${areaId} must use implemented private-grave custody`);
  }
  if (policy.keptItemCount !== 3) {
    failures.push(`${areaId} private-grave keep count must be 3`);
  }
  for (const key of [
    "ownerProtectionTicks",
    "publicTransitionTicks",
    "terminalExpirationTicks",
  ]) {
    if (policy[key] !== null) {
      failures.push(
        `${areaId}.${key} must be null for durable private custody`,
      );
    }
  }
  if (
    typeof policy.spectatorCopyKey !== "string" ||
    policy.spectatorCopyKey.length > 128 ||
    !SAFE_COPY_KEY.test(policy.spectatorCopyKey)
  ) {
    failures.push(`${areaId} death-custody spectator copy key is invalid`);
  }
  if (!new Set(["diagnostic_only", "approved"]).has(policy.approvalStatus)) {
    failures.push(`${areaId} death-custody approval status is invalid`);
  } else if (policy.approvalStatus === "approved") {
    const approvedAt = policy.approvedAt;
    if (
      typeof policy.approvalId !== "string" ||
      !SAFE_APPROVAL_ID.test(policy.approvalId)
    ) {
      failures.push(`${areaId} death-custody approval ID is invalid`);
    }
    if (
      typeof approvedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(approvedAt) ||
      !Number.isFinite(Date.parse(approvedAt)) ||
      new Date(approvedAt).toISOString() !== approvedAt
    ) {
      failures.push(`${areaId} death-custody approval time is invalid`);
    }
  } else if (
    policy.approvalId !== undefined ||
    policy.approvedAt !== undefined
  ) {
    failures.push(
      `${areaId} diagnostic death-custody policy cannot claim approval metadata`,
    );
  }
  return failures;
}

/**
 * The duel launch manifest may contain safe areas and the explicitly governed
 * agent-preparation area. It must not carry a generic PvP/public-risk zone into
 * an external-value deployment.
 */
export function validateLaunchWorldAreaSafety(worldAreas) {
  const failures = [];
  if (
    !worldAreas ||
    typeof worldAreas !== "object" ||
    Array.isArray(worldAreas)
  ) {
    return ["world-areas.json must be an object"];
  }

  for (const groupName of AREA_GROUPS) {
    const group = worldAreas[groupName];
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;

    for (const [manifestKey, area] of Object.entries(group)) {
      if (!area || typeof area !== "object" || Array.isArray(area)) continue;
      const areaId = typeof area.id === "string" ? area.id : manifestKey;
      if (manifestKey === "wilderness_test" || areaId === "wilderness_test") {
        failures.push(
          "world-areas.json must not publish retired area wilderness_test",
        );
      }
      if (area.pvpEnabled === true) {
        failures.push(
          `${areaId} must not enable generic PvP in the duel launch manifest`,
        );
      }
      if (area.safeZone !== true && area.agentPreparationArea !== true) {
        failures.push(
          `${areaId} must not expose ungoverned public-risk death custody in the duel launch manifest`,
        );
      }
      if (area.agentPreparationArea === true) {
        failures.push(
          ...validatePreparationPolicy(areaId, area.deathCustodyPolicy),
        );
      } else if (area.deathCustodyPolicy !== undefined) {
        failures.push(
          `${areaId} cannot declare preparation death custody without agentPreparationArea`,
        );
      }
    }
  }

  return failures;
}
