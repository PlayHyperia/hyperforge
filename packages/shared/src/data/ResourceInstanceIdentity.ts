import type { WorldArea } from "../types/world/world-types";
import { snapToTileCenter } from "../systems/shared/movement/TileSystem";

/**
 * A manifest tree can keep its existing durable identity when an authored layout
 * changes at restart. Procedural candidate IDs are not persistent identity input.
 */
export function validateAuthoredTreeInstanceId(
  instanceId: unknown,
  type: string,
  isManifest: boolean,
): string | undefined {
  if (instanceId === undefined) return undefined;
  if (!isManifest || type !== "tree") {
    throw new Error("Resource instanceId is supported only for authored trees");
  }
  if (typeof instanceId !== "string" || instanceId.length > 64) {
    throw new Error("Invalid authored tree instanceId");
  }
  const match = /^tree_(-?(?:0|[1-9]\d*))_(-?(?:0|[1-9]\d*))$/.exec(instanceId);
  if (
    !match ||
    match[0] !== instanceId ||
    !Number.isSafeInteger(Number(match[1])) ||
    !Number.isSafeInteger(Number(match[2])) ||
    match[1] === "-0" ||
    match[2] === "-0"
  ) {
    throw new Error("Invalid authored tree instanceId");
  }
  return instanceId;
}

/** Validate across all area groups before publishing any world-area registry. */
export function validateAuthoredResourceIdentities(
  groups: readonly (Readonly<Record<string, WorldArea>> | undefined)[],
): void {
  const seen = new Set<string>();
  const anchors = new Set<string>();
  for (const group of groups) {
    for (const area of Object.values(group ?? {})) {
      for (const resource of area.resources ?? []) {
        const explicit = validateAuthoredTreeInstanceId(
          resource.instanceId,
          resource.type,
          true,
        );
        if (resource.type !== "tree") continue;
        const position = snapToTileCenter(resource.position);
        if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
          throw new Error("Invalid authored tree position");
        }
        const id =
          explicit ?? `tree_${position.x.toFixed(0)}_${position.z.toFixed(0)}`;
        if (seen.has(id))
          throw new Error(`Duplicate authored tree identity: ${id}`);
        const anchor = `${position.x},${position.z}`;
        if (anchors.has(anchor))
          throw new Error(`Duplicate authored tree anchor: ${anchor}`);
        seen.add(id);
        anchors.add(anchor);
      }
    }
  }
}
