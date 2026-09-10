import {
  STREAMING_DUEL_PUBLIC_PRAYERS,
  STREAMING_DUEL_PUBLIC_TACTICAL_MACROS,
  type StreamingDuelPublicPrayer,
  type StreamingDuelPublicTacticalMacro,
} from "./streaming-duel-action-observation";

export const DUEL_PREPARATION_ROLE_POLICY_VERSION =
  "duel-preparation-role-v3" as const;
export const EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION =
  "external-duel-preparation-strategy-v5" as const;
export const EXTERNAL_DUEL_PREPARATION_MODEL_PROVIDER =
  "external-elizaos" as const;
export const EXTERNAL_DUEL_PREPARATION_MODEL =
  "authenticated-remote-strategy-v5" as const;
export const MAX_EXTERNAL_DUEL_PREPARATION_PLAN_OPTIONS = 6;
export const MAX_EXTERNAL_DUEL_PREPARATION_FOOD_OPTIONS = 2;
export const MAX_EXTERNAL_DUEL_PREPARATION_ARMOR_OPTIONS =
  MAX_EXTERNAL_DUEL_PREPARATION_PLAN_OPTIONS * 3;
export const MAX_EXTERNAL_DUEL_PREPARATION_OPPONENT_HISTORY = 8;

export const DUEL_PREPARATION_COMBAT_ROLES = [
  "melee",
  "ranged",
  "mage",
] as const;
export type DuelPreparationCombatRole =
  (typeof DUEL_PREPARATION_COMBAT_ROLES)[number];

export type ExternalDuelPreparationPublicProfile = {
  narrative: string;
  pillars: string[];
};

export type ExternalDuelPreparationOpponentHistoryEntry = {
  result: "win" | "loss" | "draw";
  ownOpeningStyle: DuelPreparationCombatRole | null;
  opponentOpeningStyle: DuelPreparationCombatRole | null;
  winReason: "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw";
};

export type ExternalDuelPreparationOpponentHistorySummary = {
  sampleSize: number;
  observedOpponentOpeningStyleFocus: DuelPreparationCombatRole | null;
  recent: ExternalDuelPreparationOpponentHistoryEntry[];
};

export type ExternalDuelPreparationTacticalStrategy = {
  approach: "aggressive" | "defensive" | "balanced" | "outlast";
  tacticalMacro: StreamingDuelPublicTacticalMacro;
  attackStyle: "accurate" | "aggressive" | "controlled" | "defensive";
  prayer: StreamingDuelPublicPrayer | null;
  preferredCombatRole: DuelPreparationCombatRole | null;
  foodThreshold: number;
  switchDefensiveAt: number;
  reasoning: string;
};

export type DuelPreparationBoundedStrategyDecision = {
  primaryStyle: DuelPreparationCombatRole;
  reason: string;
  tacticalStrategy: ExternalDuelPreparationTacticalStrategy;
};

/**
 * One preparation candidate whose exact weapon and required attack supplies
 * the authoritative server proved are owned and legal. The authenticated
 * external agent receives no item identifiers or bank totals; it can compare
 * bounded strategic traits and select only an opaque existing option. The
 * chosen whole plan is revalidated and committed atomically by the server.
 */
export type ExternalDuelPreparationPlanOption = {
  planOptionId: string;
  primaryStyle: DuelPreparationCombatRole;
  styleRank: number;
  attackSupplyUnits: number | null;
  canUseShield: boolean;
};

/**
 * One opaque owned healing-item choice. The server fixes the carried quantity
 * under the existing preparation policy; the external agent can select only
 * among identities the server already proved are owned and usable.
 */
export type ExternalDuelPreparationFoodOption = {
  foodOptionId: string;
  recoveryRank: number;
  quantity: number;
};

/**
 * One opaque full opening-armor set derived from the contestant's owned,
 * requirements-valid, presentation-certified equipment. Ranks are scoped to
 * the associated weapon plan. No item identity, raw bonus, bank row, or
 * quantity crosses the authenticated external strategy boundary.
 */
export type ExternalDuelPreparationArmorOption = {
  armorOptionId: string;
  planOptionId: string;
  offenseRank: number;
  focusedDefenseRank: number | null;
  totalDefenseRank: number;
};

export type ExternalDuelPreparationStrategyDecision =
  DuelPreparationBoundedStrategyDecision & {
    planOptionId: string;
    foodOptionId: string | null;
    armorOptionId: string;
  };

export type ExternalDuelPreparationStrategyRequest = {
  requestId: string;
  preparationId: string;
  policyVersion: typeof DUEL_PREPARATION_ROLE_POLICY_VERSION;
  protocolVersion: typeof EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION;
  expiresAt: number;
  decisionDeadlineAt: number;
  agentName: string;
  opponentName: string;
  ownPublicProfile: ExternalDuelPreparationPublicProfile | null;
  opponentPublicProfile: ExternalDuelPreparationPublicProfile | null;
  opponentHistorySummary: ExternalDuelPreparationOpponentHistorySummary;
  availableRoles: DuelPreparationCombatRole[];
  availablePrayerIds: StreamingDuelPublicPrayer[];
  preparationOptions: ExternalDuelPreparationPlanOption[];
  foodOptions: ExternalDuelPreparationFoodOption[];
  armorOptions: ExternalDuelPreparationArmorOption[];
  deterministicPlanOptionId: string;
  deterministicFoodOptionId: string | null;
  deterministicArmorOptionId: string;
  deterministicRole: DuelPreparationCombatRole;
};

export type ExternalDuelPreparationStrategyResponse = {
  requestId: string;
  preparationId: string;
  status: "selected" | "fallback";
  decision: ExternalDuelPreparationStrategyDecision | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_SET = new Set<string>(DUEL_PREPARATION_COMBAT_ROLES);
const PRAYER_SET = new Set<string>(STREAMING_DUEL_PUBLIC_PRAYERS);
const MACRO_SET = new Set<string>(STREAMING_DUEL_PUBLIC_TACTICAL_MACROS);
const APPROACH_SET = new Set([
  "aggressive",
  "defensive",
  "balanced",
  "outlast",
]);
const ATTACK_STYLE_SET = new Set([
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
]);
const HISTORY_RESULT_SET = new Set(["win", "loss", "draw"]);
const HISTORY_WIN_REASON_SET = new Set([
  "kill",
  "forfeit",
  "hp_advantage",
  "damage_advantage",
  "draw",
]);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const boundedText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
};

export const normalizeExternalDuelPreparationPublicName = (
  value: unknown,
): string => boundedText(value, 128);

export const normalizeExternalDuelPreparationPublicProfile = (
  value: unknown,
): ExternalDuelPreparationPublicProfile | null => {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["narrative", "pillars"])) return null;
  if (!Array.isArray(record.pillars) || record.pillars.length > 4) return null;
  const narrative = boundedText(record.narrative, 240);
  const pillars = record.pillars.map((pillar) => boundedText(pillar, 64));
  if (!narrative || pillars.some((pillar) => !pillar)) return null;
  return { narrative, pillars };
};

export const normalizeExternalDuelPreparationOpponentHistorySummary = (
  value: unknown,
): ExternalDuelPreparationOpponentHistorySummary | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "observedOpponentOpeningStyleFocus",
      "recent",
      "sampleSize",
    ]) ||
    !Array.isArray(record.recent) ||
    record.recent.length > MAX_EXTERNAL_DUEL_PREPARATION_OPPONENT_HISTORY ||
    !Number.isSafeInteger(record.sampleSize) ||
    Number(record.sampleSize) !== record.recent.length
  ) {
    return null;
  }
  const recent: ExternalDuelPreparationOpponentHistoryEntry[] = [];
  for (const candidate of record.recent) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const row = candidate as Record<string, unknown>;
    if (
      !exactKeys(row, [
        "opponentOpeningStyle",
        "ownOpeningStyle",
        "result",
        "winReason",
      ]) ||
      !HISTORY_RESULT_SET.has(row.result as string) ||
      !(
        row.ownOpeningStyle === null ||
        (typeof row.ownOpeningStyle === "string" &&
          ROLE_SET.has(row.ownOpeningStyle))
      ) ||
      !(
        row.opponentOpeningStyle === null ||
        (typeof row.opponentOpeningStyle === "string" &&
          ROLE_SET.has(row.opponentOpeningStyle))
      ) ||
      !HISTORY_WIN_REASON_SET.has(row.winReason as string) ||
      (row.result === "draw") !== (row.winReason === "draw")
    ) {
      return null;
    }
    recent.push({
      result:
        row.result as ExternalDuelPreparationOpponentHistoryEntry["result"],
      ownOpeningStyle:
        row.ownOpeningStyle as ExternalDuelPreparationOpponentHistoryEntry["ownOpeningStyle"],
      opponentOpeningStyle:
        row.opponentOpeningStyle as ExternalDuelPreparationOpponentHistoryEntry["opponentOpeningStyle"],
      winReason:
        row.winReason as ExternalDuelPreparationOpponentHistoryEntry["winReason"],
    });
  }
  const counts = new Map<
    DuelPreparationCombatRole,
    { count: number; newestIndex: number }
  >();
  recent.forEach((entry, index) => {
    if (entry.opponentOpeningStyle === null) return;
    const current = counts.get(entry.opponentOpeningStyle);
    counts.set(entry.opponentOpeningStyle, {
      count: (current?.count ?? 0) + 1,
      newestIndex: current?.newestIndex ?? index,
    });
  });
  const derivedFocus =
    [...counts.entries()].sort(
      ([leftRole, left], [rightRole, right]) =>
        right.count - left.count ||
        left.newestIndex - right.newestIndex ||
        leftRole.localeCompare(rightRole),
    )[0]?.[0] ?? null;
  if (record.observedOpponentOpeningStyleFocus !== derivedFocus) return null;
  return {
    sampleSize: recent.length,
    observedOpponentOpeningStyleFocus: derivedFocus,
    recent,
  };
};

const normalizeDistinctAllowlist = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  minimum: number,
  maximum: number,
): T[] | null => {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return null;
  }
  const normalized: T[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry) || seen.has(entry)) {
      return null;
    }
    seen.add(entry);
    normalized.push(entry as T);
  }
  return normalized;
};

const normalizePreparationOptions = (
  value: unknown,
  availableRoles: readonly DuelPreparationCombatRole[],
): ExternalDuelPreparationPlanOption[] | null => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_EXTERNAL_DUEL_PREPARATION_PLAN_OPTIONS
  ) {
    return null;
  }
  const normalized: ExternalDuelPreparationPlanOption[] = [];
  const ids = new Set<string>();
  const styleRanks = new Set<string>();
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      !exactKeys(record, [
        "attackSupplyUnits",
        "canUseShield",
        "planOptionId",
        "primaryStyle",
        "styleRank",
      ]) ||
      typeof record.planOptionId !== "string" ||
      !UUID_PATTERN.test(record.planOptionId) ||
      ids.has(record.planOptionId) ||
      typeof record.primaryStyle !== "string" ||
      !availableRoles.includes(
        record.primaryStyle as DuelPreparationCombatRole,
      ) ||
      !Number.isSafeInteger(record.styleRank) ||
      Number(record.styleRank) < 1 ||
      Number(record.styleRank) > 2 ||
      typeof record.canUseShield !== "boolean" ||
      !(
        (record.primaryStyle === "melee" &&
          record.attackSupplyUnits === null) ||
        (record.primaryStyle !== "melee" &&
          Number.isSafeInteger(record.attackSupplyUnits) &&
          Number(record.attackSupplyUnits) >= 1 &&
          Number(record.attackSupplyUnits) <= 10_000)
      )
    ) {
      return null;
    }
    const styleRankKey = `${record.primaryStyle}:${record.styleRank}`;
    if (styleRanks.has(styleRankKey)) return null;
    ids.add(record.planOptionId);
    styleRanks.add(styleRankKey);
    normalized.push({
      planOptionId: record.planOptionId,
      primaryStyle: record.primaryStyle as DuelPreparationCombatRole,
      styleRank: Number(record.styleRank),
      attackSupplyUnits:
        record.attackSupplyUnits === null
          ? null
          : Number(record.attackSupplyUnits),
      canUseShield: record.canUseShield,
    });
  }
  for (const role of availableRoles) {
    const ranks = normalized
      .filter((option) => option.primaryStyle === role)
      .map((option) => option.styleRank)
      .sort((left, right) => left - right);
    if (ranks.length === 0 || ranks.some((rank, index) => rank !== index + 1)) {
      return null;
    }
  }
  return normalized;
};

const normalizeFoodOptions = (
  value: unknown,
): ExternalDuelPreparationFoodOption[] | null => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_EXTERNAL_DUEL_PREPARATION_FOOD_OPTIONS
  ) {
    return null;
  }
  const normalized: ExternalDuelPreparationFoodOption[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      !exactKeys(record, ["foodOptionId", "quantity", "recoveryRank"]) ||
      typeof record.foodOptionId !== "string" ||
      !UUID_PATTERN.test(record.foodOptionId) ||
      ids.has(record.foodOptionId) ||
      !Number.isSafeInteger(record.recoveryRank) ||
      Number(record.recoveryRank) !== normalized.length + 1 ||
      !Number.isSafeInteger(record.quantity) ||
      Number(record.quantity) < 1 ||
      Number(record.quantity) > 28
    ) {
      return null;
    }
    ids.add(record.foodOptionId);
    normalized.push({
      foodOptionId: record.foodOptionId,
      recoveryRank: Number(record.recoveryRank),
      quantity: Number(record.quantity),
    });
  }
  return normalized;
};

const normalizeArmorOptions = (
  value: unknown,
  preparationOptions: readonly ExternalDuelPreparationPlanOption[],
): ExternalDuelPreparationArmorOption[] | null => {
  if (
    !Array.isArray(value) ||
    value.length < preparationOptions.length ||
    value.length > MAX_EXTERNAL_DUEL_PREPARATION_ARMOR_OPTIONS
  ) {
    return null;
  }
  const planIds = new Set(
    preparationOptions.map((option) => option.planOptionId),
  );
  const ids = new Set<string>();
  const normalized: ExternalDuelPreparationArmorOption[] = [];
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      !exactKeys(record, [
        "armorOptionId",
        "focusedDefenseRank",
        "offenseRank",
        "planOptionId",
        "totalDefenseRank",
      ]) ||
      typeof record.armorOptionId !== "string" ||
      !UUID_PATTERN.test(record.armorOptionId) ||
      ids.has(record.armorOptionId) ||
      typeof record.planOptionId !== "string" ||
      !planIds.has(record.planOptionId) ||
      !Number.isSafeInteger(record.offenseRank) ||
      Number(record.offenseRank) < 1 ||
      Number(record.offenseRank) > 3 ||
      !(
        record.focusedDefenseRank === null ||
        (Number.isSafeInteger(record.focusedDefenseRank) &&
          Number(record.focusedDefenseRank) >= 1 &&
          Number(record.focusedDefenseRank) <= 3)
      ) ||
      !Number.isSafeInteger(record.totalDefenseRank) ||
      Number(record.totalDefenseRank) < 1 ||
      Number(record.totalDefenseRank) > 3
    ) {
      return null;
    }
    ids.add(record.armorOptionId);
    normalized.push({
      armorOptionId: record.armorOptionId,
      planOptionId: record.planOptionId,
      offenseRank: Number(record.offenseRank),
      focusedDefenseRank:
        record.focusedDefenseRank === null
          ? null
          : Number(record.focusedDefenseRank),
      totalDefenseRank: Number(record.totalDefenseRank),
    });
  }
  for (const planOption of preparationOptions) {
    const choices = normalized.filter(
      (option) => option.planOptionId === planOption.planOptionId,
    );
    if (choices.length < 1 || choices.length > 3) return null;
    const requireContiguousRanks = (ranks: readonly number[]): boolean =>
      [...ranks]
        .sort((left, right) => left - right)
        .every((rank, index) => rank === index + 1);
    if (
      !requireContiguousRanks(choices.map((choice) => choice.offenseRank)) ||
      !requireContiguousRanks(choices.map((choice) => choice.totalDefenseRank))
    ) {
      return null;
    }
    const focusedRanks = choices.map((choice) => choice.focusedDefenseRank);
    if (!(
      focusedRanks.every((rank) => rank === null) ||
      (focusedRanks.every((rank) => rank !== null) &&
        requireContiguousRanks(focusedRanks as number[]))
    )) {
      return null;
    }
  }
  return normalized;
};

export function normalizeExternalDuelPreparationTacticalStrategy(
  value: unknown,
  availableRoles: readonly DuelPreparationCombatRole[],
  availablePrayerIds: readonly string[],
): ExternalDuelPreparationTacticalStrategy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "approach",
      "attackStyle",
      "foodThreshold",
      "prayer",
      "preferredCombatRole",
      "reasoning",
      "switchDefensiveAt",
      "tacticalMacro",
    ])
  ) {
    return null;
  }
  const prayer = record.prayer;
  const preferredCombatRole = record.preferredCombatRole;
  const reasoning = boundedText(record.reasoning, 240);
  if (
    !APPROACH_SET.has(record.approach as string) ||
    !MACRO_SET.has(record.tacticalMacro as string) ||
    !ATTACK_STYLE_SET.has(record.attackStyle as string) ||
    !(
      prayer === null ||
      (typeof prayer === "string" &&
        PRAYER_SET.has(prayer) &&
        availablePrayerIds.includes(prayer))
    ) ||
    !(
      preferredCombatRole === null ||
      (typeof preferredCombatRole === "string" &&
        ROLE_SET.has(preferredCombatRole) &&
        availableRoles.includes(
          preferredCombatRole as DuelPreparationCombatRole,
        ))
    ) ||
    !Number.isSafeInteger(record.foodThreshold) ||
    Number(record.foodThreshold) < 20 ||
    Number(record.foodThreshold) > 60 ||
    !Number.isSafeInteger(record.switchDefensiveAt) ||
    Number(record.switchDefensiveAt) < 20 ||
    Number(record.switchDefensiveAt) > 40 ||
    !reasoning
  ) {
    return null;
  }
  return {
    approach:
      record.approach as ExternalDuelPreparationTacticalStrategy["approach"],
    tacticalMacro:
      record.tacticalMacro as ExternalDuelPreparationTacticalStrategy["tacticalMacro"],
    attackStyle:
      record.attackStyle as ExternalDuelPreparationTacticalStrategy["attackStyle"],
    prayer: prayer as ExternalDuelPreparationTacticalStrategy["prayer"],
    preferredCombatRole:
      preferredCombatRole as ExternalDuelPreparationTacticalStrategy["preferredCombatRole"],
    foodThreshold: Number(record.foodThreshold),
    switchDefensiveAt: Number(record.switchDefensiveAt),
    reasoning,
  };
}

export function normalizeExternalDuelPreparationStrategyDecision(
  value: unknown,
  availableRoles: readonly DuelPreparationCombatRole[],
  availablePrayerIds: readonly string[],
): DuelPreparationBoundedStrategyDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["primaryStyle", "reason", "tacticalStrategy"])) {
    return null;
  }
  const primaryStyle = record.primaryStyle;
  const reason = boundedText(record.reason, 240);
  const tacticalStrategy = normalizeExternalDuelPreparationTacticalStrategy(
    record.tacticalStrategy,
    availableRoles,
    availablePrayerIds,
  );
  if (
    typeof primaryStyle !== "string" ||
    !ROLE_SET.has(primaryStyle) ||
    !availableRoles.includes(primaryStyle as DuelPreparationCombatRole) ||
    !reason ||
    !tacticalStrategy
  ) {
    return null;
  }
  return {
    primaryStyle: primaryStyle as DuelPreparationCombatRole,
    reason,
    tacticalStrategy,
  };
}

export function normalizeExternalDuelPreparationPlanStrategyDecision(
  value: unknown,
  preparationOptions: readonly ExternalDuelPreparationPlanOption[],
  foodOptions: readonly ExternalDuelPreparationFoodOption[],
  armorOptions: readonly ExternalDuelPreparationArmorOption[],
  availablePrayerIds: readonly string[],
): ExternalDuelPreparationStrategyDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "armorOptionId",
      "foodOptionId",
      "planOptionId",
      "primaryStyle",
      "reason",
      "tacticalStrategy",
    ]) ||
    typeof record.planOptionId !== "string"
  ) {
    return null;
  }
  const selectedOption = preparationOptions.find(
    (option) => option.planOptionId === record.planOptionId,
  );
  const selectedFoodOption =
    record.foodOptionId === null
      ? null
      : foodOptions.find(
          (option) => option.foodOptionId === record.foodOptionId,
        );
  const selectedArmorOption = armorOptions.find(
    (option) => option.armorOptionId === record.armorOptionId,
  );
  if (
    !selectedOption ||
    !selectedArmorOption ||
    selectedArmorOption.planOptionId !== selectedOption.planOptionId ||
    record.primaryStyle !== selectedOption.primaryStyle ||
    (foodOptions.length === 0) !== (record.foodOptionId === null) ||
    (record.foodOptionId !== null && !selectedFoodOption)
  ) {
    return null;
  }
  const availableRoles = [
    ...new Set(preparationOptions.map((option) => option.primaryStyle)),
  ];
  const decision = normalizeExternalDuelPreparationStrategyDecision(
    {
      primaryStyle: record.primaryStyle,
      reason: record.reason,
      tacticalStrategy: record.tacticalStrategy,
    },
    availableRoles,
    availablePrayerIds,
  );
  return decision
    ? {
        armorOptionId: selectedArmorOption.armorOptionId,
        planOptionId: selectedOption.planOptionId,
        foodOptionId: selectedFoodOption?.foodOptionId ?? null,
        ...decision,
      }
    : null;
}

export function normalizeExternalDuelPreparationStrategyRequest(
  value: unknown,
): ExternalDuelPreparationStrategyRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "agentName",
      "armorOptions",
      "availablePrayerIds",
      "availableRoles",
      "decisionDeadlineAt",
      "deterministicFoodOptionId",
      "deterministicArmorOptionId",
      "deterministicPlanOptionId",
      "deterministicRole",
      "expiresAt",
      "foodOptions",
      "opponentName",
      "opponentHistorySummary",
      "opponentPublicProfile",
      "ownPublicProfile",
      "policyVersion",
      "preparationOptions",
      "preparationId",
      "protocolVersion",
      "requestId",
    ])
  ) {
    return null;
  }
  const availableRoles = normalizeDistinctAllowlist<DuelPreparationCombatRole>(
    record.availableRoles,
    ROLE_SET,
    1,
    DUEL_PREPARATION_COMBAT_ROLES.length,
  );
  const availablePrayerIds =
    normalizeDistinctAllowlist<StreamingDuelPublicPrayer>(
      record.availablePrayerIds,
      PRAYER_SET,
      0,
      STREAMING_DUEL_PUBLIC_PRAYERS.length,
    );
  const agentName = normalizeExternalDuelPreparationPublicName(
    record.agentName,
  );
  const opponentName = normalizeExternalDuelPreparationPublicName(
    record.opponentName,
  );
  const ownPublicProfile = normalizeExternalDuelPreparationPublicProfile(
    record.ownPublicProfile,
  );
  const opponentPublicProfile = normalizeExternalDuelPreparationPublicProfile(
    record.opponentPublicProfile,
  );
  const opponentHistorySummary =
    normalizeExternalDuelPreparationOpponentHistorySummary(
      record.opponentHistorySummary,
    );
  const preparationOptions = availableRoles
    ? normalizePreparationOptions(record.preparationOptions, availableRoles)
    : null;
  const foodOptions = normalizeFoodOptions(record.foodOptions);
  const armorOptions = preparationOptions
    ? normalizeArmorOptions(record.armorOptions, preparationOptions)
    : null;
  const deterministicOption = preparationOptions?.find(
    (option) => option.planOptionId === record.deterministicPlanOptionId,
  );
  const deterministicArmorOption = armorOptions?.find(
    (option) => option.armorOptionId === record.deterministicArmorOptionId,
  );
  if (
    typeof record.requestId !== "string" ||
    !UUID_PATTERN.test(record.requestId) ||
    typeof record.preparationId !== "string" ||
    !UUID_PATTERN.test(record.preparationId) ||
    record.policyVersion !== DUEL_PREPARATION_ROLE_POLICY_VERSION ||
    record.protocolVersion !==
      EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION ||
    !Number.isSafeInteger(record.expiresAt) ||
    !Number.isSafeInteger(record.decisionDeadlineAt) ||
    Number(record.expiresAt) <= Number(record.decisionDeadlineAt) ||
    !agentName ||
    !opponentName ||
    (record.ownPublicProfile !== null && ownPublicProfile === null) ||
    (record.opponentPublicProfile !== null && opponentPublicProfile === null) ||
    !opponentHistorySummary ||
    !availableRoles ||
    !availablePrayerIds ||
    !preparationOptions ||
    !foodOptions ||
    !armorOptions ||
    !deterministicOption ||
    !deterministicArmorOption ||
    deterministicArmorOption.planOptionId !==
      deterministicOption.planOptionId ||
    deterministicArmorOption.offenseRank !== 1 ||
    deterministicOption.styleRank !== 1 ||
    typeof record.deterministicRole !== "string" ||
    !availableRoles.includes(
      record.deterministicRole as DuelPreparationCombatRole,
    ) ||
    deterministicOption.primaryStyle !== record.deterministicRole ||
    !(
      (foodOptions.length === 0 && record.deterministicFoodOptionId === null) ||
      (foodOptions.length > 0 &&
        typeof record.deterministicFoodOptionId === "string" &&
        foodOptions[0]?.foodOptionId === record.deterministicFoodOptionId)
    )
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    preparationId: record.preparationId,
    policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
    protocolVersion: EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
    expiresAt: Number(record.expiresAt),
    decisionDeadlineAt: Number(record.decisionDeadlineAt),
    agentName,
    opponentName,
    ownPublicProfile,
    opponentPublicProfile,
    opponentHistorySummary,
    availableRoles,
    availablePrayerIds,
    preparationOptions,
    foodOptions,
    armorOptions,
    deterministicPlanOptionId: deterministicOption.planOptionId,
    deterministicFoodOptionId:
      foodOptions.length > 0 ? foodOptions[0]!.foodOptionId : null,
    deterministicArmorOptionId: deterministicArmorOption.armorOptionId,
    deterministicRole: record.deterministicRole as DuelPreparationCombatRole,
  };
}

export function normalizeExternalDuelPreparationStrategyResponse(
  value: unknown,
  preparationOptions: readonly ExternalDuelPreparationPlanOption[],
  foodOptions: readonly ExternalDuelPreparationFoodOption[],
  armorOptions: readonly ExternalDuelPreparationArmorOption[],
  availablePrayerIds: readonly string[],
): ExternalDuelPreparationStrategyResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["decision", "preparationId", "requestId", "status"])
  ) {
    return null;
  }
  if (
    typeof record.requestId !== "string" ||
    !UUID_PATTERN.test(record.requestId) ||
    typeof record.preparationId !== "string" ||
    !UUID_PATTERN.test(record.preparationId) ||
    (record.status !== "selected" && record.status !== "fallback")
  ) {
    return null;
  }
  const decision = normalizeExternalDuelPreparationPlanStrategyDecision(
    record.decision,
    preparationOptions,
    foodOptions,
    armorOptions,
    availablePrayerIds,
  );
  if (
    (record.status === "selected" && decision === null) ||
    (record.status === "fallback" && record.decision !== null)
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    preparationId: record.preparationId,
    status: record.status,
    decision,
  };
}
