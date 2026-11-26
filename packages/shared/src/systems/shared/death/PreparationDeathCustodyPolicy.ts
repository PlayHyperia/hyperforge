import type { WorldArea } from "../../../types/core/core";

export type PreparationDeathCustodyPolicy = NonNullable<
  WorldArea["deathCustodyPolicy"]
>;

export type ValidatedPreparationDeathCustodyPolicy =
  PreparationDeathCustodyPolicy & {
    mode: "private_grave";
  };

const SAFE_COPY_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function validNullableTick(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

export function validatePreparationDeathCustodyPolicy(
  area: WorldArea,
  options: { requireApproval: boolean },
): { policy: ValidatedPreparationDeathCustodyPolicy | null; errors: string[] } {
  if (area.agentPreparationArea !== true) {
    return { policy: null, errors: [] };
  }

  const errors: string[] = [];
  const policy = area.deathCustodyPolicy;
  if (!policy || typeof policy !== "object") {
    return {
      policy: null,
      errors: [
        `Area ${area.id} is missing its preparation death-custody policy`,
      ],
    };
  }
  if (area.pvpEnabled === true) {
    errors.push(`Area ${area.id} cannot be both preparation and PvP enabled`);
  }
  if (policy.version !== 1) {
    errors.push(`Area ${area.id} has an unsupported death-custody version`);
  }
  if (policy.mode !== "private_grave") {
    errors.push(
      `Area ${area.id} death-custody mode ${String(policy.mode)} is not implemented`,
    );
  }
  if (
    !Number.isSafeInteger(policy.keptItemCount) ||
    policy.keptItemCount !== 3
  ) {
    errors.push(
      `Area ${area.id} private-grave keep count must match the implemented value`,
    );
  }
  if (
    !validNullableTick(policy.ownerProtectionTicks) ||
    !validNullableTick(policy.publicTransitionTicks) ||
    !validNullableTick(policy.terminalExpirationTicks)
  ) {
    errors.push(`Area ${area.id} death-custody timing is invalid`);
  }
  if (
    policy.ownerProtectionTicks !== null ||
    policy.publicTransitionTicks !== null ||
    policy.terminalExpirationTicks !== null
  ) {
    errors.push(
      `Area ${area.id} private grave must remain owner-only until exact recovery`,
    );
  }
  if (
    typeof policy.spectatorCopyKey !== "string" ||
    policy.spectatorCopyKey.length > 128 ||
    !SAFE_COPY_KEY.test(policy.spectatorCopyKey)
  ) {
    errors.push(`Area ${area.id} death-custody spectator copy key is invalid`);
  }
  if (
    !(["diagnostic_only", "approved"] as const).includes(policy.approvalStatus)
  ) {
    errors.push(`Area ${area.id} death-custody approval status is invalid`);
  }
  if (policy.approvalStatus === "approved") {
    if (
      typeof policy.approvalId !== "string" ||
      !SAFE_APPROVAL_ID.test(policy.approvalId)
    ) {
      errors.push(`Area ${area.id} death-custody approval ID is invalid`);
    }
    if (
      typeof policy.approvedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        policy.approvedAt,
      ) ||
      !Number.isFinite(Date.parse(policy.approvedAt)) ||
      new Date(policy.approvedAt).toISOString() !== policy.approvedAt
    ) {
      errors.push(`Area ${area.id} death-custody approval time is invalid`);
    }
  } else if (
    policy.approvalId !== undefined ||
    policy.approvedAt !== undefined
  ) {
    errors.push(
      `Area ${area.id} diagnostic death-custody policy cannot claim approval metadata`,
    );
  }
  if (options.requireApproval && policy.approvalStatus !== "approved") {
    errors.push(`Area ${area.id} death-custody policy is not launch approved`);
  }

  return {
    policy:
      errors.length === 0
        ? (policy as ValidatedPreparationDeathCustodyPolicy)
        : null,
    errors,
  };
}

export function validatePreparationDeathCustodyAreas(
  areas: Record<string, WorldArea>,
  options: { requireApproval: boolean },
): string[] {
  return Object.values(areas).flatMap(
    (area) => validatePreparationDeathCustodyPolicy(area, options).errors,
  );
}

/**
 * External-value mode cannot expose an ordinary public-risk death path. Every
 * non-safe area must be the explicitly governed preparation area; its separate
 * policy validator then requires approved private custody. This also prevents
 * a retired test/PvP area from being reintroduced through a manifest change.
 */
export function validateExternalValueWorldAreaSafety(
  areas: Record<string, WorldArea>,
  options: { externalValueEnabled: boolean },
): string[] {
  if (!options.externalValueEnabled) return [];

  return Object.values(areas).flatMap((area) => {
    const errors: string[] = [];
    if (area.pvpEnabled === true) {
      errors.push(
        `Area ${area.id} enables unapproved PvP while external value is enabled`,
      );
    }
    if (area.safeZone !== true && area.agentPreparationArea !== true) {
      errors.push(
        `Area ${area.id} exposes unapproved public-risk death custody while external value is enabled`,
      );
    }
    return errors;
  });
}

export function isExternalValueEnabled(
  env: Readonly<Record<string, string | undefined>> = typeof process !==
    "undefined" && typeof process.env !== "undefined"
    ? process.env
    : {},
): boolean {
  return env.HYPERIA_EXTERNAL_VALUE_ENABLED === "true";
}

export function requirePreparationDeathCustodyPolicy(
  area: WorldArea,
): ValidatedPreparationDeathCustodyPolicy {
  const result = validatePreparationDeathCustodyPolicy(area, {
    requireApproval: false,
  });
  if (!result.policy) {
    throw new Error(
      `preparation_death_custody_policy_invalid:${result.errors.join("|")}`,
    );
  }
  return result.policy;
}
