export type DeclaredRendererHealth = Readonly<{
  ready?: boolean;
  degradedReason?: string | null;
  updatedAt?: number | null;
  phase?: string | null;
}>;

export type ObservedRendererHealth = Readonly<{
  ready: boolean;
  degradedReason: string | null;
  updatedAt: number;
  phase: string | null;
}>;

/**
 * Converts renderer-declared state into capture-process authority.
 *
 * The browser declaration timestamp records when React last changed the state;
 * an unchanged healthy IDLE scene can legitimately retain that value for
 * minutes. A successful isolated page probe is a new observation, so freshness
 * must be stamped with the probe time while preserving the declared state.
 */
export function observeRendererHealth(input: {
  declared: DeclaredRendererHealth;
  probedAt: number;
  criticalUiVisible: boolean;
  criticalReason: string;
}): ObservedRendererHealth {
  if (!Number.isSafeInteger(input.probedAt) || input.probedAt <= 0) {
    throw new Error(
      "renderer health probe time must be a positive safe integer",
    );
  }
  const criticalReason = input.criticalReason.trim();
  if (input.criticalUiVisible && criticalReason.length === 0) {
    throw new Error("critical renderer health requires a bounded reason");
  }
  return Object.freeze({
    ready: input.criticalUiVisible ? false : input.declared.ready === true,
    degradedReason: input.criticalUiVisible
      ? criticalReason
      : typeof input.declared.degradedReason === "string"
        ? input.declared.degradedReason
        : null,
    updatedAt: input.probedAt,
    phase:
      typeof input.declared.phase === "string" ? input.declared.phase : null,
  });
}
