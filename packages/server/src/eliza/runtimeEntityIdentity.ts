/**
 * Resolve the exact authored mob identity exposed by a live runtime entity.
 *
 * MobEntity keeps this identity in both its config and property bag, while
 * some serialized entities also copy it into data. Display names and entity
 * ids are deliberately excluded because they are not authoritative content
 * identities.
 */
export function getAuthoritativeRuntimeMobType(
  entity: unknown,
  data?: Record<string, unknown>,
): string | undefined {
  const runtime = entity as {
    config?: { mobType?: unknown };
    getProperty?: (name: string) => unknown;
  };
  const candidates: unknown[] = [
    data?.mobType,
    runtime.config?.mobType,
    runtime.getProperty?.("mobType"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return undefined;
}
