export const AVATAR_AUTHORED_MOTION_SCHEMA_VERSION = 1 as const;
export const AVATAR_AUTHORED_MOTION_ACTION_LIMIT = 8;
export const AVATAR_AUTHORED_MOTION_URL_MAX_LENGTH = 200;

export type AvatarAuthoredMotionActionDiagnostics = {
  url: string;
  running: boolean;
  paused: boolean;
  effectiveWeight: number;
};

export type AvatarAuthoredMotionDiagnostics = {
  schemaVersion: typeof AVATAR_AUTHORED_MOTION_SCHEMA_VERSION;
  overflow: boolean;
  invalidActionCount: number;
  actions: readonly AvatarAuthoredMotionActionDiagnostics[];
};

type AuthoredMotionAction = {
  paused: boolean;
  isScheduled: () => boolean;
  isRunning: () => boolean;
  getEffectiveWeight: () => number;
};

export type AvatarAuthoredMotionEntry = {
  url: string;
  loading: boolean;
  action: AuthoredMotionAction | null;
};

export const EMPTY_AVATAR_AUTHORED_MOTION_DIAGNOSTICS = Object.freeze({
  schemaVersion: AVATAR_AUTHORED_MOTION_SCHEMA_VERSION,
  overflow: false,
  invalidActionCount: 0,
  actions: Object.freeze([]),
}) satisfies AvatarAuthoredMotionDiagnostics;

export function sanitizeAvatarAuthoredMotionUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().split(/[?#]/, 1)[0];
  if (
    normalized.length === 0 ||
    normalized.length > AVATAR_AUTHORED_MOTION_URL_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  try {
    const parsed = new URL(normalized, "https://authored-motion.invalid");
    if (parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return normalized;
}

/**
 * Report only authored actions that currently contribute positive mixer weight.
 * The caller supplies its owned action registry so this never inspects Three.js
 * private mixer internals or exposes an unbounded animation history.
 */
export function collectAvatarAuthoredMotionDiagnostics(
  entries: Iterable<AvatarAuthoredMotionEntry>,
): AvatarAuthoredMotionDiagnostics {
  const actions: AvatarAuthoredMotionActionDiagnostics[] = [];
  let overflow = false;
  let invalidActionCount = 0;

  const markInvalid = () => {
    invalidActionCount = Math.min(
      invalidActionCount + 1,
      AVATAR_AUTHORED_MOTION_ACTION_LIMIT + 1,
    );
  };

  for (const entry of entries) {
    if (entry.loading) continue;
    if (!entry.action) {
      markInvalid();
      continue;
    }

    try {
      const scheduled = entry.action.isScheduled();
      const running = entry.action.isRunning();
      const paused = entry.action.paused;
      const effectiveWeight = entry.action.getEffectiveWeight();
      if (!scheduled) continue;
      if (
        !Number.isFinite(effectiveWeight) ||
        effectiveWeight < 0 ||
        effectiveWeight > 1
      ) {
        markInvalid();
        continue;
      }
      if (effectiveWeight === 0) continue;
      const url = sanitizeAvatarAuthoredMotionUrl(entry.url);
      if (!url || typeof running !== "boolean" || typeof paused !== "boolean") {
        markInvalid();
        continue;
      }
      if (actions.length >= AVATAR_AUTHORED_MOTION_ACTION_LIMIT) {
        overflow = true;
        continue;
      }
      actions.push({
        url,
        running,
        paused,
        effectiveWeight,
      });
    } catch {
      markInvalid();
    }
  }

  return {
    schemaVersion: AVATAR_AUTHORED_MOTION_SCHEMA_VERSION,
    overflow,
    invalidActionCount,
    actions,
  };
}
