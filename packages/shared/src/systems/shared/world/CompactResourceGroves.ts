/** Frozen functional-resource placement, not another random/decorative population. */
import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import { getTreeLevelRequired } from "../../../constants/TreeTypes";
import type { CompactResourceGrovesManifest } from "../../../types/world/world-types";
import {
  centeredTerrainTileIndex,
  type ResourceNode,
  type TerrainResourceBatchOwner,
} from "../../../types/world/terrain";
import {
  validateTreeAnchor,
  type TreeGenerationSource,
} from "./BiomeResourceGenerator";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

export const COMPACT_RESOURCE_GROVE_CAP = 16;
export const COMPACT_RESOURCE_GROVE_V2_CAP = 40;
const REGION_IDS = [
  "west-ridge-foot",
  "southern-meadow",
  "eastern-shoulder",
] as const;
const MAX_ANCHOR_SLOPE = 0.35;

function fail(field: string): never {
  throw new Error(`Invalid compactResourceGroves: ${field}`);
}
function record(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((k) => !Object.prototype.hasOwnProperty.call(result, k))
  )
    fail(`${field} fields`);
  return result;
}
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field);
  return value;
}

/** Startup-only detached JSON validation; normal worlds keep the absent legacy path. */
export function validateCompactResourceGroves(
  value: unknown,
  profile: WorldTerrainProfile,
  worldConfigVersion: number,
): CompactResourceGrovesManifest | undefined {
  if (value === undefined) {
    if (worldConfigVersion === 2)
      fail("version 2 requires its explicit grove layout");
    return undefined;
  }
  if (
    worldConfigVersion !== 2 ||
    !(
      (profile.id === "compact-duel-island-v4" &&
        profile.algorithm === "compact-island-sculpt-v3") ||
      (profile.id === "compact-duel-island-v5" &&
        profile.algorithm === "compact-island-sculpt-v4")
    ) ||
    profile.terrainTileSize !== 100
  )
    fail("version/profile");
  // Reject accessors, non-JSON values, cycles and structural/byte abuse before
  // inspecting values. DataManager also validates the enclosing configuration.
  const copy: unknown = JSON.parse(canonicalWorldJson(value));
  const layout = record(
    copy,
    ["schemaVersion", "layoutId", "terrainProfileId", "regions"],
    "layout",
  );
  const legacy =
    layout.schemaVersion === 1 &&
    layout.layoutId === "compact-functional-groves-v1";
  const grouped =
    layout.schemaVersion === 2 &&
    layout.layoutId === "compact-functional-groves-v2" &&
    profile.id === "compact-duel-island-v5";
  if ((!legacy && !grouped) || layout.terrainProfileId !== profile.id)
    fail("layout identity");
  const cap = grouped
    ? COMPACT_RESOURCE_GROVE_V2_CAP
    : COMPACT_RESOURCE_GROVE_CAP;
  if (
    !Array.isArray(layout.regions) ||
    layout.regions.length !== REGION_IDS.length
  )
    fail("regions");
  const regionIds = new Set<string>(),
    ids = new Set<string>();
  let count = 0;
  for (const input of layout.regions) {
    const region = record(input, ["id", "bounds", "anchors"], "region");
    if (
      typeof region.id !== "string" ||
      !(REGION_IDS as readonly string[]).includes(region.id) ||
      regionIds.has(region.id)
    )
      fail("region identity");
    regionIds.add(region.id);
    const bounds = record(
      region.bounds,
      ["minX", "maxX", "minZ", "maxZ"],
      "bounds",
    );
    const minX = finite(bounds.minX, "minX"),
      maxX = finite(bounds.maxX, "maxX"),
      minZ = finite(bounds.minZ, "minZ"),
      maxZ = finite(bounds.maxZ, "maxZ");
    if (
      minX >= maxX ||
      minZ >= maxZ ||
      minX < Math.max(250, profile.bounds.minX) ||
      maxX > Math.min(550, profile.bounds.maxX) ||
      minZ < Math.max(250, profile.bounds.minZ) ||
      maxZ > Math.min(550, profile.bounds.maxZ)
    )
      fail("bounds outside compact content core");
    if (
      !Array.isArray(region.anchors) ||
      region.anchors.length === 0 ||
      region.anchors.length > cap
    )
      fail("region anchors");
    for (const inputAnchor of region.anchors) {
      if (++count > cap) fail("anchor cap");
      const anchor = record(
        inputAnchor,
        ["id", "subType", "position", "scale", "rotation"],
        "anchor",
      );
      const p = record(anchor.position, ["x", "y", "z"], "position");
      const x = finite(p.x, "x"),
        y = finite(p.y, "y"),
        z = finite(p.z, "z");
      if (!Number.isSafeInteger(x - 0.5) || !Number.isSafeInteger(z - 0.5))
        fail("unsnapped anchor");
      if (
        x < minX ||
        x >= maxX ||
        z < minZ ||
        z >= maxZ ||
        y <= profile.water.threshold ||
        y > profile.height.maxHeightParameter
      )
        fail("anchor bounds");
      if (
        typeof anchor.id !== "string" ||
        anchor.id !== `tree_${x.toFixed(0)}_${z.toFixed(0)}` ||
        ids.has(anchor.id)
      )
        fail("duplicate or non-coordinate ID");
      ids.add(anchor.id);
      if (anchor.subType !== "general" && anchor.subType !== "oak")
        fail("species");
      // No continuous/random scale range; historical v1 remains full-size only.
      if (anchor.scale !== 1 && !(grouped && anchor.scale === 0.8))
        fail("scale");
      const rotation = finite(anchor.rotation, "rotation");
      if (rotation < 0 || rotation >= Math.PI * 2) fail("rotation range");
    }
  }
  // All members have been checked above, including unknown field rejection.
  return copy as CompactResourceGrovesManifest;
}

/** Materialize only one live content owner. No RNG, resampling or instanceId. */
export function createCompactResourceGroveNodes(
  layout: CompactResourceGrovesManifest | undefined,
  owner: TerrainResourceBatchOwner,
  source: TreeGenerationSource,
  reservedIds: ReadonlySet<string>,
  isExcludedAt: (x: number, z: number) => boolean,
): ResourceNode[] {
  if (!layout) return [];
  const size = source.context.tileSize;
  if (
    !Number.isSafeInteger(owner.tileX) ||
    !Number.isSafeInteger(owner.tileZ) ||
    size !== 100
  )
    fail("owner");
  const nodes: ResourceNode[] = [];
  const physicalSource = {
    context: source.context,
    config: { ...source.config, maxSlope: MAX_ANCHOR_SLOPE },
  };
  for (const region of layout.regions)
    for (const anchor of region.anchors) {
      const { x, y, z } = anchor.position;
      if (
        centeredTerrainTileIndex(x, size) !== owner.tileX ||
        centeredTerrainTileIndex(z, size) !== owner.tileZ
      )
        continue;
      if (reservedIds.has(anchor.id))
        fail(`existing resource collision ${anchor.id}`);
      const admitted = validateTreeAnchor(physicalSource, x, z, isExcludedAt);
      if (admitted.rejection || Math.abs(admitted.position.y - y) > 1e-7)
        fail(
          `physical anchor ${anchor.id}: ${admitted.rejection ?? "ground height changed"}`,
        );
      nodes.push({
        id: anchor.id,
        type: "tree",
        subType: anchor.subType,
        position: {
          x: x - owner.tileX * size,
          y: admitted.position.y,
          z: z - owner.tileZ * size,
        },
        scale: anchor.scale,
        rotation: anchor.rotation,
        // ResourceSystem derives actual health/yield/respawn/level from the same
        // species manifest as ordinary generator points; these are tile metadata.
        health: 100,
        maxHealth: 100,
        respawnTime: 300000,
        harvestable: true,
        requiredLevel: getTreeLevelRequired(anchor.subType),
      });
    }
  return nodes;
}
