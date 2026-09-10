/**
 * Privacy-safe, server-authored observations for the public duel broadcast.
 *
 * This contract deliberately excludes coordinates, inventory/bank custody,
 * wallet identity, transport details, and model reasoning. Every accepted
 * object has one exact key set and action-specific value/outcome semantics.
 */

export const STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const STREAMING_DUEL_ACTION_OBSERVATION_LIMIT = 32;

export const STREAMING_DUEL_PUBLIC_COMBAT_ROLES = [
  "melee",
  "ranged",
  "mage",
] as const;

export const STREAMING_DUEL_PUBLIC_TACTICAL_MACROS = [
  "pressure",
  "hold_range",
  "kite",
  "orbit",
  "defensive_reset",
  "finish",
] as const;

export const STREAMING_DUEL_PUBLIC_PRAYERS = [
  "superhuman_strength",
  "rock_skin",
  "hawk_eye",
  "mystic_lore",
] as const;

export const STREAMING_DUEL_PUBLIC_STYLES = [
  "accurate",
  "aggressive",
  "controlled",
  "defensive",
  "longrange",
  "rapid",
] as const;

export type StreamingDuelPublicCombatRole =
  (typeof STREAMING_DUEL_PUBLIC_COMBAT_ROLES)[number];
export type StreamingDuelPublicTacticalMacro =
  (typeof STREAMING_DUEL_PUBLIC_TACTICAL_MACROS)[number];
export type StreamingDuelPublicPrayer =
  (typeof STREAMING_DUEL_PUBLIC_PRAYERS)[number];
export type StreamingDuelPublicStyle =
  (typeof STREAMING_DUEL_PUBLIC_STYLES)[number];

/**
 * Server-authored identity captured before a duel food action crosses the
 * custody boundary. Database completion turns this exact context into the
 * committed public observation in the same transaction as the health effect.
 */
export type StreamingDuelFoodObservationContext = Readonly<{
  operationId: string;
  tick: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  opponentId: string;
  phase: "FIGHTING";
  combatRole: StreamingDuelPublicCombatRole;
  tacticalMacro: StreamingDuelPublicTacticalMacro;
}>;

/**
 * Server-authored identity captured before a duel prayer toggle crosses the
 * custody boundary. The requested public prayer is included so persistence can
 * prove that the committed membership transition matches the observation.
 */
export type StreamingDuelPrayerObservationContext = Readonly<{
  operationId: string;
  tick: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  opponentId: string;
  phase: "FIGHTING";
  combatRole: StreamingDuelPublicCombatRole;
  tacticalMacro: StreamingDuelPublicTacticalMacro;
  prayer: StreamingDuelPublicPrayer;
}>;

/**
 * Server-authored identity captured before a frozen combat-role switch enters
 * inventory/equipment/spell custody. Only the public target role is retained.
 */
export type StreamingDuelRoleSwitchObservationContext = Readonly<{
  operationId: string;
  tick: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  opponentId: string;
  phase: "FIGHTING";
  combatRole: StreamingDuelPublicCombatRole;
  tacticalMacro: StreamingDuelPublicTacticalMacro;
  targetRole: StreamingDuelPublicCombatRole;
}>;

/**
 * Server-authored identity captured before an attack-style change crosses
 * durable player-state custody. The requested public style is retained so the
 * database can prove that the committed combat preference matches the public
 * acknowledgement.
 */
export type StreamingDuelStyleObservationContext = Readonly<{
  operationId: string;
  tick: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  opponentId: string;
  phase: "FIGHTING";
  combatRole: StreamingDuelPublicCombatRole;
  tacticalMacro: StreamingDuelPublicTacticalMacro;
  style: StreamingDuelPublicStyle;
}>;

/**
 * Exact public identity for a durable movement or engagement executor command.
 * Private movement coordinates and run mode live only in the immutable command
 * receipt; the public observation retains the existing bounded semantics.
 */
export type StreamingDuelExecutorObservationContext = Readonly<
  {
    operationId: string;
    tick: number;
    observedAt: number;
    cycleId: string;
    duelId: string;
    actorId: string;
    opponentId: string;
    phase: "FIGHTING";
    combatRole: StreamingDuelPublicCombatRole;
    tacticalMacro: StreamingDuelPublicTacticalMacro;
  } & (
    | { action: "movement"; value: "reposition" }
    | {
        action: "engagement";
        value: "initial" | "keep_alive";
      }
  )
>;

/**
 * Server-authored identity captured before duel damage crosses durable health
 * custody. The requested amount is bound into the receipt; persistence writes
 * the actually applied (health-capped) amount to the public observation.
 */
export type StreamingDuelDamageObservationContext = Readonly<{
  operationId: string;
  tick: number;
  observedAt: number;
  cycleId: string;
  duelId: string;
  actorId: string;
  opponentId: string;
  phase: "FIGHTING";
  combatRole: StreamingDuelPublicCombatRole;
  tacticalMacro: StreamingDuelPublicTacticalMacro;
  requestedDamage: number;
}>;

type StreamingDuelActionObservationBase = {
  readonly schemaVersion: typeof STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION;
  readonly sequence: number;
  readonly tick: number;
  readonly observedAt: number;
  readonly cycleId: string;
  readonly duelId: string;
  readonly actorId: string;
  readonly opponentId: string;
  readonly phase: "FIGHTING";
  readonly combatRole: StreamingDuelPublicCombatRole;
  readonly tacticalMacro: StreamingDuelPublicTacticalMacro;
};

export type StreamingDuelActionObservation =
  | (StreamingDuelActionObservationBase & {
      readonly action: "movement";
      readonly outcome: "accepted" | "rejected" | "error";
      readonly value: "reposition";
      readonly amount: null;
    })
  | (StreamingDuelActionObservationBase & {
      readonly action: "engagement";
      readonly outcome: "accepted" | "rejected" | "error";
      readonly value: "initial" | "keep_alive";
      readonly amount: null;
    })
  | (StreamingDuelActionObservationBase &
      (
        | {
            readonly action: "food";
            readonly outcome: "deferred";
            readonly value: "disengage";
            readonly amount: null;
          }
        | {
            readonly action: "food";
            readonly outcome: "committed";
            readonly value: "consume";
            readonly amount: number;
          }
        | {
            readonly action: "food";
            readonly outcome: "rejected" | "error";
            readonly value: "consume";
            readonly amount: null;
          }
      ))
  | (StreamingDuelActionObservationBase & {
      readonly action: "prayer";
      readonly outcome: "committed" | "rejected" | "error";
      readonly value: StreamingDuelPublicPrayer;
      readonly amount: null;
    })
  | (StreamingDuelActionObservationBase & {
      readonly action: "style";
      readonly outcome: "accepted" | "rejected" | "error";
      readonly value: StreamingDuelPublicStyle;
      readonly amount: null;
    })
  | (StreamingDuelActionObservationBase & {
      readonly action: "role_switch";
      readonly outcome: "committed" | "rejected" | "error" | "deferred";
      readonly value: StreamingDuelPublicCombatRole;
      readonly amount: null;
    })
  | (StreamingDuelActionObservationBase & {
      readonly action: "damage";
      readonly outcome: "committed";
      readonly value: "hit";
      readonly amount: number;
    });

const EXACT_KEYS = [
  "action",
  "actorId",
  "amount",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "opponentId",
  "outcome",
  "phase",
  "schemaVersion",
  "sequence",
  "tacticalMacro",
  "tick",
  "value",
] as const;

const FOOD_OBSERVATION_CONTEXT_EXACT_KEYS = [
  "actorId",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "operationId",
  "opponentId",
  "phase",
  "tacticalMacro",
  "tick",
] as const;

const PRAYER_OBSERVATION_CONTEXT_EXACT_KEYS = [
  "actorId",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "operationId",
  "opponentId",
  "phase",
  "prayer",
  "tacticalMacro",
  "tick",
] as const;

const ROLE_SWITCH_OBSERVATION_CONTEXT_EXACT_KEYS = [
  "actorId",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "operationId",
  "opponentId",
  "phase",
  "tacticalMacro",
  "targetRole",
  "tick",
] as const;

const STYLE_OBSERVATION_CONTEXT_EXACT_KEYS = [
  "actorId",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "operationId",
  "opponentId",
  "phase",
  "style",
  "tacticalMacro",
  "tick",
] as const;

const EXECUTOR_OBSERVATION_CONTEXT_EXACT_KEYS = [
  "action",
  "actorId",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "operationId",
  "opponentId",
  "phase",
  "tacticalMacro",
  "tick",
  "value",
] as const;

const DAMAGE_OBSERVATION_CONTEXT_EXACT_KEYS = [
  "actorId",
  "combatRole",
  "cycleId",
  "duelId",
  "observedAt",
  "operationId",
  "opponentId",
  "phase",
  "requestedDamage",
  "tacticalMacro",
  "tick",
] as const;

const COMBAT_ROLES = new Set<string>(STREAMING_DUEL_PUBLIC_COMBAT_ROLES);
const TACTICAL_MACROS = new Set<string>(STREAMING_DUEL_PUBLIC_TACTICAL_MACROS);
const PRAYERS = new Set<string>(STREAMING_DUEL_PUBLIC_PRAYERS);
const STYLES = new Set<string>(STREAMING_DUEL_PUBLIC_STYLES);
const SAFE_PUBLIC_ID =
  /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,256}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === EXACT_KEYS.length &&
    EXACT_KEYS.every((key, index) => keys[index] === key)
  );
}

function isSafePublicId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PUBLIC_ID.test(value);
}

function isSafePositiveAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSafeNonnegativeAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * Validate the narrow server-to-database context used for atomic duel food
 * publication. Extra fields are rejected so private controller state can
 * never be smuggled into a durable public receipt.
 */
export function parseStreamingDuelFoodObservationContext(
  input: unknown,
): StreamingDuelFoodObservationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== FOOD_OBSERVATION_CONTEXT_EXACT_KEYS.length ||
    !FOOD_OBSERVATION_CONTEXT_EXACT_KEYS.every(
      (key, index) => keys[index] === key,
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId)
  ) {
    return null;
  }

  const observation = parseStreamingDuelActionObservation({
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence: 1,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: "food",
    outcome: "committed",
    value: "consume",
    amount: 0,
  });
  if (!observation || observation.action !== "food") return null;

  return Object.freeze({
    operationId: value.operationId,
    tick: observation.tick,
    observedAt: observation.observedAt,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    phase: observation.phase,
    combatRole: observation.combatRole,
    tacticalMacro: observation.tacticalMacro,
  });
}

/**
 * Validate the narrow server-to-database context used for atomic duel prayer
 * publication. Exact keys prevent private controller state from entering the
 * durable public receipt.
 */
export function parseStreamingDuelPrayerObservationContext(
  input: unknown,
): StreamingDuelPrayerObservationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== PRAYER_OBSERVATION_CONTEXT_EXACT_KEYS.length ||
    !PRAYER_OBSERVATION_CONTEXT_EXACT_KEYS.every(
      (key, index) => keys[index] === key,
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId)
  ) {
    return null;
  }

  const observation = parseStreamingDuelActionObservation({
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence: 1,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: "prayer",
    outcome: "committed",
    value: value.prayer,
    amount: null,
  });
  if (!observation || observation.action !== "prayer") return null;

  return Object.freeze({
    operationId: value.operationId,
    tick: observation.tick,
    observedAt: observation.observedAt,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    phase: observation.phase,
    combatRole: observation.combatRole,
    tacticalMacro: observation.tacticalMacro,
    prayer: observation.value,
  });
}

/** Validate an exact privacy-safe frozen-role switch context. */
export function parseStreamingDuelRoleSwitchObservationContext(
  input: unknown,
): StreamingDuelRoleSwitchObservationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== ROLE_SWITCH_OBSERVATION_CONTEXT_EXACT_KEYS.length ||
    !ROLE_SWITCH_OBSERVATION_CONTEXT_EXACT_KEYS.every(
      (key, index) => keys[index] === key,
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId)
  ) {
    return null;
  }

  const observation = parseStreamingDuelActionObservation({
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence: 1,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: "role_switch",
    outcome: "committed",
    value: value.targetRole,
    amount: null,
  });
  if (!observation || observation.action !== "role_switch") return null;

  return Object.freeze({
    operationId: value.operationId,
    tick: observation.tick,
    observedAt: observation.observedAt,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    phase: observation.phase,
    combatRole: observation.combatRole,
    tacticalMacro: observation.tacticalMacro,
    targetRole: observation.value,
  });
}

/** Validate an exact privacy-safe attack-style custody context. */
export function parseStreamingDuelStyleObservationContext(
  input: unknown,
): StreamingDuelStyleObservationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== STYLE_OBSERVATION_CONTEXT_EXACT_KEYS.length ||
    !STYLE_OBSERVATION_CONTEXT_EXACT_KEYS.every(
      (key, index) => keys[index] === key,
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId)
  ) {
    return null;
  }

  const observation = parseStreamingDuelActionObservation({
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence: 1,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: "style",
    outcome: "accepted",
    value: value.style,
    amount: null,
  });
  if (!observation || observation.action !== "style") return null;

  return Object.freeze({
    operationId: value.operationId,
    tick: observation.tick,
    observedAt: observation.observedAt,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    phase: observation.phase,
    combatRole: observation.combatRole,
    tacticalMacro: observation.tacticalMacro,
    style: observation.value,
  });
}

/** Validate an exact privacy-safe movement/engagement command context. */
export function parseStreamingDuelExecutorObservationContext(
  input: unknown,
): StreamingDuelExecutorObservationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXECUTOR_OBSERVATION_CONTEXT_EXACT_KEYS.length ||
    !EXECUTOR_OBSERVATION_CONTEXT_EXACT_KEYS.every(
      (key, index) => keys[index] === key,
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    (value.action !== "movement" && value.action !== "engagement")
  ) {
    return null;
  }

  const observation = parseStreamingDuelActionObservation({
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence: 1,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: value.action,
    outcome: "accepted",
    value: value.value,
    amount: null,
  });
  if (
    !observation ||
    (observation.action !== "movement" && observation.action !== "engagement")
  ) {
    return null;
  }

  return Object.freeze({
    operationId: value.operationId,
    tick: observation.tick,
    observedAt: observation.observedAt,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    phase: observation.phase,
    combatRole: observation.combatRole,
    tacticalMacro: observation.tacticalMacro,
    action: observation.action,
    value: observation.value,
  }) as StreamingDuelExecutorObservationContext;
}

/** Validate an exact privacy-safe authoritative duel-damage context. */
export function parseStreamingDuelDamageObservationContext(
  input: unknown,
): StreamingDuelDamageObservationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== DAMAGE_OBSERVATION_CONTEXT_EXACT_KEYS.length ||
    !DAMAGE_OBSERVATION_CONTEXT_EXACT_KEYS.every(
      (key, index) => keys[index] === key,
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    !isSafePositiveAmount(value.requestedDamage)
  ) {
    return null;
  }

  const observation = parseStreamingDuelActionObservation({
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence: 1,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: "damage",
    outcome: "committed",
    value: "hit",
    amount: value.requestedDamage,
  });
  if (!observation || observation.action !== "damage") return null;

  return Object.freeze({
    operationId: value.operationId,
    tick: observation.tick,
    observedAt: observation.observedAt,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    phase: observation.phase,
    combatRole: observation.combatRole,
    tacticalMacro: observation.tacticalMacro,
    requestedDamage: observation.amount,
  });
}

/**
 * Parse an observation crossing a process/network boundary. The returned
 * object is a fresh frozen copy, so caller-owned mutation cannot alter a
 * retained public history entry after validation.
 */
export function parseStreamingDuelActionObservation(
  input: unknown,
): StreamingDuelActionObservation | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value)) return null;
  if (
    value.schemaVersion !== STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !Number.isSafeInteger(value.tick) ||
    Number(value.tick) < 0 ||
    !Number.isSafeInteger(value.observedAt) ||
    Number(value.observedAt) <= 0 ||
    !isSafePublicId(value.cycleId) ||
    !isSafePublicId(value.duelId) ||
    !isSafePublicId(value.actorId) ||
    !isSafePublicId(value.opponentId) ||
    value.actorId === value.opponentId ||
    value.phase !== "FIGHTING" ||
    typeof value.combatRole !== "string" ||
    !COMBAT_ROLES.has(value.combatRole) ||
    typeof value.tacticalMacro !== "string" ||
    !TACTICAL_MACROS.has(value.tacticalMacro) ||
    typeof value.action !== "string" ||
    typeof value.outcome !== "string" ||
    typeof value.value !== "string"
  ) {
    return null;
  }

  const amountIsNull = value.amount === null;
  let actionIsValid = false;
  switch (value.action) {
    case "movement":
      actionIsValid =
        value.value === "reposition" &&
        amountIsNull &&
        (value.outcome === "accepted" ||
          value.outcome === "rejected" ||
          value.outcome === "error");
      break;
    case "engagement":
      actionIsValid =
        (value.value === "initial" || value.value === "keep_alive") &&
        amountIsNull &&
        (value.outcome === "accepted" ||
          value.outcome === "rejected" ||
          value.outcome === "error");
      break;
    case "food":
      actionIsValid =
        (value.outcome === "deferred" &&
          value.value === "disengage" &&
          amountIsNull) ||
        (value.outcome === "committed" &&
          value.value === "consume" &&
          isSafeNonnegativeAmount(value.amount)) ||
        ((value.outcome === "rejected" || value.outcome === "error") &&
          value.value === "consume" &&
          amountIsNull);
      break;
    case "prayer":
      actionIsValid =
        PRAYERS.has(value.value) &&
        amountIsNull &&
        (value.outcome === "committed" ||
          value.outcome === "rejected" ||
          value.outcome === "error");
      break;
    case "style":
      actionIsValid =
        STYLES.has(value.value) &&
        amountIsNull &&
        (value.outcome === "accepted" ||
          value.outcome === "rejected" ||
          value.outcome === "error");
      break;
    case "role_switch":
      actionIsValid =
        COMBAT_ROLES.has(value.value) &&
        amountIsNull &&
        (value.outcome === "committed" ||
          value.outcome === "rejected" ||
          value.outcome === "error" ||
          value.outcome === "deferred");
      break;
    case "damage":
      actionIsValid =
        value.outcome === "committed" &&
        value.value === "hit" &&
        isSafePositiveAmount(value.amount);
      break;
  }
  if (!actionIsValid) return null;

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    tick: value.tick,
    observedAt: value.observedAt,
    cycleId: value.cycleId,
    duelId: value.duelId,
    actorId: value.actorId,
    opponentId: value.opponentId,
    phase: value.phase,
    combatRole: value.combatRole,
    tacticalMacro: value.tacticalMacro,
    action: value.action,
    outcome: value.outcome,
    value: value.value,
    amount: value.amount,
  }) as StreamingDuelActionObservation;
}
