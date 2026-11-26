/**
 * Biome Resource Generator
 *
 * Extracted algorithms for generating harvestable resources (trees, ores)
 * based on biome configuration. Used by TerrainSystem and directly testable.
 *
 * Design principles:
 * - Pure functions for testability
 * - No side effects - returns resource arrays
 * - Deterministic via seeded RNG
 * - Real terrain height lookups via callback
 */

import type {
  BiomeTreeConfig,
  BiomeOreConfig,
  BiomeRockConfig,
  BiomePlantConfig,
} from "../../../types/world/world-types";
import type {
  ResourceNode,
  ResourceSubType,
  TerrainResourceBatchOwner,
} from "../../../types/world/terrain";
import { centeredTerrainTileIndex } from "../../../types/world/terrain";
import { snapToTileCenter } from "../movement/TileSystem";
import type { VegetationInstance } from "../../../types/world/world-types";
import {
  getTreeLevelRequired,
  treeIdToSubType,
} from "../../../constants/TreeTypes";
import type { TreePlacementRules } from "../../../constants/TreeTypes";
import { getTreeConfigForBiome } from "./TerrainBiomeTypes";

// ---------------------------------------------------------------------------
// Bridson's Poisson Disk Sampling — O(n) blue-noise point generation
// ---------------------------------------------------------------------------

/**
 * Generate well-spaced 2D points using Bridson's algorithm.
 * Points are guaranteed to be at least `minDistance` apart while packing
 * as densely as possible (blue noise distribution).
 *
 * An optional `padding` expands the sampling area beyond the output bounds
 * so that points near tile edges respect spacing against hypothetical
 * neighbors, reducing cross-tile clumping.
 */
function poissonDiskSample2D(
  width: number,
  height: number,
  minDistance: number,
  rng: () => number,
  padding = 0,
  k = 30,
): Array<{ x: number; z: number }> {
  if (width <= 0 || height <= 0 || minDistance <= 0) return [];

  const r2 = minDistance * minDistance;
  const cellSize = minDistance / Math.SQRT2;

  const xMin = -padding;
  const zMin = -padding;
  const xMax = width + padding;
  const zMax = height + padding;
  const sampleW = xMax - xMin;
  const sampleH = zMax - zMin;

  const cols = Math.ceil(sampleW / cellSize);
  const rows = Math.ceil(sampleH / cellSize);
  const grid = new Int32Array(cols * rows).fill(-1);

  const samplesX: number[] = [];
  const samplesZ: number[] = [];
  const active: number[] = [];

  const addSample = (x: number, z: number): void => {
    const idx = samplesX.length;
    samplesX.push(x);
    samplesZ.push(z);
    active.push(idx);
    const ix = Math.floor((x - xMin) / cellSize);
    const iz = Math.floor((z - zMin) / cellSize);
    grid[iz * cols + ix] = idx;
  };

  const isFarEnough = (x: number, z: number): boolean => {
    const ix = Math.floor((x - xMin) / cellSize);
    const iz = Math.floor((z - zMin) / cellSize);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const si = grid[nz * cols + nx];
        if (si === -1) continue;
        const ddx = x - samplesX[si];
        const ddz = z - samplesZ[si];
        if (ddx * ddx + ddz * ddz < r2) return false;
      }
    }
    return true;
  };

  addSample(xMin + rng() * sampleW, zMin + rng() * sampleH);

  const twoPi = Math.PI * 2;
  while (active.length > 0) {
    const ai = Math.floor(rng() * active.length);
    const pi = active[ai];
    const px = samplesX[pi];
    const pz = samplesZ[pi];

    let found = false;
    for (let i = 0; i < k; i++) {
      const radius = minDistance * Math.sqrt(1 + 3 * rng());
      const theta = rng() * twoPi;
      const x = px + radius * Math.cos(theta);
      const z = pz + radius * Math.sin(theta);

      if (x < xMin || x >= xMax || z < zMin || z >= zMax) continue;
      if (!isFarEnough(x, z)) continue;

      addSample(x, z);
      found = true;
      break;
    }

    if (!found) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }

  const result: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < samplesX.length; i++) {
    const x = samplesX[i];
    const z = samplesZ[i];
    if (x >= 0 && x < width && z >= 0 && z < height) {
      result.push({ x, z });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Species zoning — smooth 2D value noise so nearby trees tend to be the same type
// ---------------------------------------------------------------------------

const SPECIES_ZONE_SCALE = 0.012; // ~80m species zones
const SPECIES_ZONE_BOOST = 3.0; // preferred species gets 3x weight
const WATER_PROXIMITY_BOOST = 20.0; // water-affinity trees get 20x weight near water
const WATER_HEIGHT_PRECHECK = 35; // only run expensive water search within this height above water

const DENSITY_NOISE_SCALE = 0.006; // ~170m dense/sparse zones
const DENSITY_NOISE_MIN = 0.15; // sparse zones still get 15% of trees
const DENSITY_NOISE_POWER = 1.5; // push noise toward extremes

function intHash2D(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = (h ^ (h >>> 16)) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

function speciesNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const h00 = intHash2D(ix, iz);
  const h10 = intHash2D(ix + 1, iz);
  const h01 = intHash2D(ix, iz + 1);
  const h11 = intHash2D(ix + 1, iz + 1);
  return (
    h00 * (1 - ux) * (1 - uz) +
    h10 * ux * (1 - uz) +
    h01 * (1 - ux) * uz +
    h11 * ux * uz
  );
}

// ---------------------------------------------------------------------------
// Distance-to-water sampling — 8-direction radial search for nearest shoreline
// ---------------------------------------------------------------------------

const WATER_SEARCH_DIRECTIONS = 8;
const WATER_SEARCH_STEP = 5; // meters between samples

/**
 * Find the horizontal distance from (worldX, worldZ) to the nearest water cell.
 * Casts rays in 8 directions, stepping every WATER_SEARCH_STEP meters.
 * Returns the distance in meters, or Infinity if no water found within searchRadius.
 */
function distanceToWater(
  worldX: number,
  worldZ: number,
  getHeightAt: (x: number, z: number) => number,
  waterThreshold: number,
  searchRadius: number,
): number {
  let nearest = Infinity;
  const angleStep = (Math.PI * 2) / WATER_SEARCH_DIRECTIONS;
  const maxSteps = Math.ceil(searchRadius / WATER_SEARCH_STEP);

  for (let dir = 0; dir < WATER_SEARCH_DIRECTIONS; dir++) {
    const angle = dir * angleStep;
    const dx = Math.cos(angle) * WATER_SEARCH_STEP;
    const dz = Math.sin(angle) * WATER_SEARCH_STEP;

    for (let step = 1; step <= maxSteps; step++) {
      const dist = step * WATER_SEARCH_STEP;
      if (dist >= nearest) break; // can't beat current best
      const sx = worldX + dx * step;
      const sz = worldZ + dz * step;
      if (getHeightAt(sx, sz) < waterThreshold) {
        nearest = dist;
        break; // this direction found water, move to next
      }
    }
  }

  return nearest;
}

/**
 * Context provided by TerrainSystem for resource generation.
 */
export interface ResourceGenerationContext {
  /** Tile X coordinate */
  tileX: number;
  /** Tile Z coordinate */
  tileZ: number;
  /** Tile key for resource IDs */
  tileKey: string;
  /** Tile size in meters */
  tileSize: number;
  /** Water height threshold */
  waterThreshold: number;
  /** Get terrain height at world coordinates */
  getHeightAt: (worldX: number, worldZ: number) => number;
  /** Check if position is on a road */
  isOnRoad?: (worldX: number, worldZ: number) => boolean;
  /** Get water surface Y at world position (river + ponds + ocean) */
  getWaterSurfaceAt?: (worldX: number, worldZ: number) => number;
  /** Get the dominant biome at a world position (for per-tree biome selection) */
  getDominantBiome?: (worldX: number, worldZ: number) => string;
  /** Deterministic RNG seeded for this tile */
  createRng: (salt: string) => () => number;
}

export interface TreeGenerationSource {
  context: ResourceGenerationContext;
  config: BiomeTreeConfig;
}

export type TreeAnchorRejectionReason =
  "non_finite" | "water" | "road" | "slope" | "excluded";

export interface CenteredTreeGenerationResult {
  resources: ResourceNode[];
  sourceCellsGenerated: number;
  sourceCandidates: number;
  ownedCandidates: number;
  rejected: Array<{
    id: string;
    position: { x: number; y: number; z: number };
    reason: TreeAnchorRejectionReason;
  }>;
}

/** Reapply the existing land-tree rules at the final one-metre game anchor. */
export function validateTreeAnchor(
  source: TreeGenerationSource,
  x: number,
  z: number,
  isExcludedAt?: (x: number, z: number) => boolean,
): {
  position: { x: number; y: number; z: number };
  rejection: TreeAnchorRejectionReason | null;
} {
  const { context, config } = source;
  const position = snapToTileCenter({ x, y: 0, z });
  let rejection: TreeAnchorRejectionReason | null = null;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    return { position, rejection: "non_finite" };
  }
  position.y = context.getHeightAt(position.x, position.z);
  const water = context.getWaterSurfaceAt?.(position.x, position.z);
  if (
    !Number.isFinite(position.y) ||
    (water !== undefined && !Number.isFinite(water))
  ) {
    rejection = "non_finite";
  } else if (
    position.y < context.waterThreshold ||
    (water !== undefined && position.y <= water + 1)
  ) {
    rejection = "water";
  } else if (context.isOnRoad?.(position.x, position.z)) {
    rejection = "road";
  } else if (isExcludedAt?.(position.x, position.z)) {
    rejection = "excluded";
  } else if (config.maxSlope !== undefined && config.maxSlope < Infinity) {
    const dx =
      (context.getHeightAt(position.x + 1, position.z) -
        context.getHeightAt(position.x - 1, position.z)) *
      0.5;
    const dz =
      (context.getHeightAt(position.x, position.z + 1) -
        context.getHeightAt(position.x, position.z - 1)) *
      0.5;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) rejection = "non_finite";
    else if (dx * dx + dz * dz > config.maxSlope * config.maxSlope)
      rejection = "slope";
  }
  return { position, rejection };
}

/**
 * Retain the original positive-local seeded lattice, but give every tree one
 * centred gameplay owner. Moving the lattice itself would move every tree and
 * change its durable coordinate-based identity. No rejected tree is backfilled.
 * Four source cells intersect a centred tile; generate each at most once here.
 */
export function generateCenteredTrees(
  owner: TerrainResourceBatchOwner,
  tileSize: number,
  createSource: (tileX: number, tileZ: number) => TreeGenerationSource,
  isExcludedAt?: (x: number, z: number) => boolean,
): CenteredTreeGenerationResult {
  if (
    !Number.isInteger(owner.tileX) ||
    !Number.isInteger(owner.tileZ) ||
    !Number.isSafeInteger(tileSize) ||
    tileSize <= 0
  ) {
    throw new Error(
      "Centred tree ownership requires integer tiles and a positive whole-metre tile size",
    );
  }
  const result: CenteredTreeGenerationResult = {
    resources: [],
    sourceCellsGenerated: 0,
    sourceCandidates: 0,
    ownedCandidates: 0,
    rejected: [],
  };
  for (let sourceX = owner.tileX - 1; sourceX <= owner.tileX; sourceX++) {
    for (let sourceZ = owner.tileZ - 1; sourceZ <= owner.tileZ; sourceZ++) {
      const { context, config } = createSource(sourceX, sourceZ);
      if (
        context.tileX !== sourceX ||
        context.tileZ !== sourceZ ||
        context.tileSize !== tileSize
      ) {
        throw new Error(
          "Tree source context does not match its seeded lattice cell",
        );
      }
      const candidates = generateTrees(context, config);
      result.sourceCellsGenerated++;
      result.sourceCandidates += candidates.length;
      for (const candidate of candidates) {
        const position = snapToTileCenter({
          x: sourceX * tileSize + candidate.position.x,
          y: candidate.position.y,
          z: sourceZ * tileSize + candidate.position.z,
        });
        if (
          centeredTerrainTileIndex(position.x, tileSize) !== owner.tileX ||
          centeredTerrainTileIndex(position.z, tileSize) !== owner.tileZ
        )
          continue;
        result.ownedCandidates++;
        const admitted = validateTreeAnchor(
          { context, config },
          position.x,
          position.z,
          isExcludedAt,
        );
        position.y = admitted.position.y;
        const reason = admitted.rejection;
        if (reason) {
          result.rejected.push({ id: candidate.id, position, reason });
          continue;
        }
        result.resources.push({
          ...candidate,
          position: {
            x: position.x - owner.tileX * tileSize,
            y: position.y,
            z: position.z - owner.tileZ * tileSize,
          },
        });
      }
    }
  }
  return result;
}

/**
 * @deprecated Use getTreeLevelRequired() from TreeTypes.ts instead.
 * Kept for backward compatibility — delegates to the single source of truth.
 */
export const TREE_LEVEL_REQUIREMENTS: Record<string, number> = new Proxy(
  {} as Record<string, number>,
  { get: (_target, prop: string) => getTreeLevelRequired(prop) },
);

/**
 * Mapping from game tree subtypes to @hyperforge/procgen presets.
 * Used for runtime procedural tree generation (visual variety).
 *
 * These presets define the visual characteristics of each tree type:
 * - normal: Common deciduous tree (Quaking Aspen)
 * - oak: Classic oak with spreading branches
 * - willow: Distinctive drooping branches
 * - teak: Tall tropical deciduous
 * - maple: Multi-trunk with palmate leaves
 * - mahogany: Large deciduous with dark wood
 * - yew: Ancient coniferous tree
 * - magic: Mystical tree with blossoms
 */
export const TREE_PROCGEN_PRESETS: Record<string, string> = {
  normal: "quakingAspen",
  oak: "blackOak",
  willow: "weepingWillow",
  teak: "blackTupelo",
  maple: "acer",
  mahogany: "sassafras",
  yew: "europeanLarch",
  magic: "hillCherry",
};

/**
 * Get the procgen preset name for a tree subtype.
 * Falls back to quakingAspen for unknown types.
 */
export function getTreeProcgenPreset(subType: string): string {
  return TREE_PROCGEN_PRESETS[subType] ?? "quakingAspen";
}

/**
 * Level requirements for ore types (classic MMORPG mining levels).
 * Single source of truth - used by both generation and tests.
 */
export const ORE_LEVEL_REQUIREMENTS: Record<string, number> = {
  copper: 1,
  tin: 1,
  iron: 15,
  coal: 30,
  mithril: 55,
  adamant: 70,
  runite: 85,
};

/**
 * Get the level requirement for a tree type.
 * @deprecated Use getTreeLevelRequired() from TreeTypes.ts directly.
 */
export function getTreeLevelRequirement(subType: string): number {
  return getTreeLevelRequired(subType);
}

/**
 * Get the level requirement for an ore type.
 */
export function getOreLevelRequirement(subType: string): number {
  return ORE_LEVEL_REQUIREMENTS[subType] ?? 1;
}

/**
 * Generate harvestable trees for a tile based on biome configuration.
 *
 * @param ctx - Resource generation context from TerrainSystem
 * @param treeConfig - Biome tree configuration
 * @returns Array of ResourceNode objects for trees
 */
export function generateTrees(
  ctx: ResourceGenerationContext,
  treeConfig: BiomeTreeConfig,
): ResourceNode[] {
  if (!treeConfig.enabled) {
    return [];
  }

  const tileArea = (ctx.tileSize / 100) * (ctx.tileSize / 100);
  const baseCount = Math.floor(treeConfig.density * tileArea);
  if (baseCount === 0) return [];

  const maxSlope = treeConfig.maxSlope ?? Infinity;
  const rng = ctx.createRng("trees");

  const tileTreeMap = treeConfig.trees;
  const tileTreeTypes = Object.keys(tileTreeMap);
  if (tileTreeTypes.length === 0) return [];
  const tileTotalWeight = Object.values(tileTreeMap).reduce(
    (sum, cfg) => sum + cfg.weight,
    0,
  );
  if (tileTotalWeight === 0) return [];

  // --- Phase 1: Generate well-spaced candidate positions via Poisson disk ---
  const minSpacing = treeConfig.minSpacing;
  let candidates = poissonDiskSample2D(
    ctx.tileSize,
    ctx.tileSize,
    minSpacing,
    rng,
    minSpacing,
  );

  // Clustering: place well-spaced cluster centers via Poisson disk, then keep
  // only candidates within a cluster radius. Creates natural groves with clearings.
  if (treeConfig.clustering) {
    const treesPerCluster = treeConfig.clusterSize ?? 4;
    const numClusters = Math.max(1, Math.ceil(baseCount / treesPerCluster));
    const clusterRadius =
      treeConfig.clusterRadius ?? treesPerCluster * minSpacing;
    const clusterSpacing = treeConfig.clusterSpacing ?? clusterRadius * 2;
    const clusterRadiusSq = clusterRadius * clusterRadius;

    const centers = poissonDiskSample2D(
      ctx.tileSize,
      ctx.tileSize,
      clusterSpacing,
      rng,
      clusterSpacing,
    );
    // Shuffle and trim to desired cluster count
    for (let i = centers.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = centers[i];
      centers[i] = centers[j];
      centers[j] = tmp;
    }
    centers.length = Math.min(centers.length, numClusters);

    candidates = candidates.filter((p) => {
      for (const c of centers) {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        if (dx * dx + dz * dz < clusterRadiusSq) return true;
      }
      return false;
    });
  }

  // Shuffle candidates so terrain-filter order doesn't create spatial bias
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }

  // --- Phase 2: Filter candidates through terrain + biome rules ---
  const resources: ResourceNode[] = [];
  const [minScale, maxScale] = treeConfig.scaleVariation ?? [0.8, 1.2];

  for (const pos of candidates) {
    if (resources.length >= baseCount) break;

    const localX = pos.x;
    const localZ = pos.z;
    const worldX = ctx.tileX * ctx.tileSize + localX;
    const worldZ = ctx.tileZ * ctx.tileSize + localZ;
    const height = ctx.getHeightAt(worldX, worldZ);

    if (height < ctx.waterThreshold) continue;
    if (ctx.getWaterSurfaceAt) {
      const waterY = ctx.getWaterSurfaceAt(worldX, worldZ);
      if (height <= waterY + 1.0) continue;
    }

    if (ctx.isOnRoad?.(worldX, worldZ)) continue;

    if (maxSlope < Infinity) {
      const sd = 1.0;
      const dhdx =
        (ctx.getHeightAt(worldX + sd, worldZ) -
          ctx.getHeightAt(worldX - sd, worldZ)) /
        (2 * sd);
      const dhdz =
        (ctx.getHeightAt(worldX, worldZ + sd) -
          ctx.getHeightAt(worldX, worldZ - sd)) /
        (2 * sd);
      if (dhdx * dhdx + dhdz * dhdz > maxSlope * maxSlope) continue;
    }

    // Density noise — natural dense groves and sparse clearings
    const rawDensity = speciesNoise2D(
      (worldX + 500) * DENSITY_NOISE_SCALE,
      (worldZ + 500) * DENSITY_NOISE_SCALE,
    );
    const densityChance =
      DENSITY_NOISE_MIN +
      (1 - DENSITY_NOISE_MIN) * Math.pow(rawDensity, DENSITY_NOISE_POWER);
    if (rng() > densityChance) continue;

    // Per-position biome override at biome boundaries
    let activeTreeMap = tileTreeMap;
    let treeTypes = tileTreeTypes;

    if (ctx.getDominantBiome) {
      const positionBiome = ctx.getDominantBiome(worldX, worldZ);
      const posConfig = getTreeConfigForBiome(positionBiome);
      if (posConfig && posConfig.trees !== tileTreeMap) {
        activeTreeMap = posConfig.trees;
        treeTypes = Object.keys(activeTreeMap);
        const tw = Object.values(activeTreeMap).reduce(
          (sum, cfg) => sum + cfg.weight,
          0,
        );
        if (tw === 0 || treeTypes.length === 0) continue;
      }
    }

    // Water proximity (cached per-position)
    const heightAboveWater = height - ctx.waterThreshold;
    let posDistToWater = Infinity;
    let waterChecked = false;

    if (heightAboveWater <= WATER_HEIGHT_PRECHECK) {
      let maxSearch = 0;
      for (const treeType of treeTypes) {
        const cfg = activeTreeMap[treeType];
        if (cfg.waterAffinity && cfg.waterAffinity > 0) {
          maxSearch = Math.max(maxSearch, cfg.waterSearchRadius ?? 40);
        }
      }
      if (maxSearch > 0) {
        posDistToWater = distanceToWater(
          worldX,
          worldZ,
          ctx.getHeightAt,
          ctx.waterThreshold,
          maxSearch,
        );
        waterChecked = true;
      }
    }

    const nearWater = waterChecked && posDistToWater < Infinity;

    // Species selection — weight-proportional zoning + water proximity boost
    const zoneVal = speciesNoise2D(
      worldX * SPECIES_ZONE_SCALE,
      worldZ * SPECIES_ZONE_SCALE,
    );
    let activeTotalWeight = 0;
    for (const tt of treeTypes) activeTotalWeight += activeTreeMap[tt].weight;
    const scaledZone = zoneVal * activeTotalWeight;
    let zoneAccum = 0;
    let preferredSpecies = treeTypes[0];
    for (const tt of treeTypes) {
      zoneAccum += activeTreeMap[tt].weight;
      if (scaledZone < zoneAccum) {
        preferredSpecies = tt;
        break;
      }
    }

    let boostedTotal = 0;
    for (const treeType of treeTypes) {
      let w = activeTreeMap[treeType].weight;
      if (treeType === preferredSpecies) w *= SPECIES_ZONE_BOOST;
      if (nearWater && activeTreeMap[treeType].waterAffinity) {
        w *= WATER_PROXIMITY_BOOST;
      }
      boostedTotal += w;
    }

    let selectedTreeId = treeTypes[0];
    const roll = rng() * boostedTotal;
    let cumulative = 0;
    for (const treeType of treeTypes) {
      let w = activeTreeMap[treeType].weight;
      if (treeType === preferredSpecies) w *= SPECIES_ZONE_BOOST;
      if (nearWater && activeTreeMap[treeType].waterAffinity) {
        w *= WATER_PROXIMITY_BOOST;
      }
      cumulative += w;
      if (roll < cumulative) {
        selectedTreeId = treeType;
        break;
      }
    }
    const selectedType = treeIdToSubType(selectedTreeId);

    // Per-tree placement rules (height, water affinity, etc.)
    const rules: TreePlacementRules | undefined = activeTreeMap[selectedTreeId];
    if (rules) {
      if (rules.minHeight !== undefined && height < rules.minHeight) continue;
      if (rules.maxHeight !== undefined && height > rules.maxHeight) continue;

      if (
        rules.avoidsWaterBelow !== undefined &&
        heightAboveWater < rules.avoidsWaterBelow
      )
        continue;

      if (rules.waterAffinity && rules.waterAffinity > 0) {
        const maxDist = rules.waterMaxDistance ?? 30;
        let dist = posDistToWater;
        if (!waterChecked) {
          const searchRadius = rules.waterSearchRadius ?? 40;
          dist = distanceToWater(
            worldX,
            worldZ,
            ctx.getHeightAt,
            ctx.waterThreshold,
            searchRadius,
          );
        }
        if (dist === Infinity) continue;
        if (dist > maxDist) {
          if (rules.waterAffinity >= 0.5 || rng() < rules.waterAffinity)
            continue;
        }
      }
    }

    const scale = minScale + rng() * (maxScale - minScale);
    const rotation = rng() * Math.PI * 2;

    resources.push({
      id: `${ctx.tileKey}_tree_${resources.length}`,
      type: "tree",
      subType: selectedType as ResourceSubType,
      position: { x: localX, y: height, z: localZ },
      mesh: null,
      health: 100,
      maxHealth: 100,
      respawnTime: 300000,
      harvestable: true,
      requiredLevel: getTreeLevelRequirement(selectedType),
      scale,
      rotation,
    });
  }

  return resources;
}

/**
 * Generate ore nodes for a tile based on biome configuration.
 * Supports ore veins (clusters) for more natural distribution.
 *
 * @param ctx - Resource generation context from TerrainSystem
 * @param oreConfig - Biome ore configuration
 * @returns Array of ResourceNode objects for ores
 */
export function generateOres(
  ctx: ResourceGenerationContext,
  oreConfig: BiomeOreConfig,
): ResourceNode[] {
  if (!oreConfig.enabled) {
    return [];
  }

  const resources: ResourceNode[] = [];

  // Calculate ore count based on density
  const tileArea = (ctx.tileSize / 100) * (ctx.tileSize / 100);
  const baseCount = Math.floor(oreConfig.density * tileArea);

  if (baseCount === 0) {
    return [];
  }

  // Use deterministic RNG
  const rng = ctx.createRng("ores");

  // Get distribution weights
  const distribution = oreConfig.distribution;
  const oreTypes = Object.keys(distribution);
  if (oreTypes.length === 0) {
    return [];
  }

  const totalWeight = Object.values(distribution).reduce(
    (sum, w) => sum + w,
    0,
  );
  if (totalWeight === 0) {
    return [];
  }

  // Track placed positions for spacing
  const placedPositions: Array<{ x: number; z: number }> = [];
  const minSpacing = oreConfig.minSpacing;
  const minSpacingSq = minSpacing * minSpacing;

  // If veins enabled, generate vein centers
  const veinCenters: Array<{ x: number; z: number; oreType: string }> = [];
  if (oreConfig.veins && oreConfig.veinSize) {
    const numVeins = Math.max(1, Math.ceil(baseCount / oreConfig.veinSize));
    for (let i = 0; i < numVeins; i++) {
      // Select ore type for this vein
      let selectedType = oreTypes[0];
      const roll = rng() * totalWeight;
      let cumulative = 0;
      for (const oreType of oreTypes) {
        cumulative += distribution[oreType];
        if (roll < cumulative) {
          selectedType = oreType;
          break;
        }
      }

      veinCenters.push({
        x: rng() * ctx.tileSize,
        z: rng() * ctx.tileSize,
        oreType: selectedType,
      });
    }
  }

  let oresPlaced = 0;
  const maxAttempts = baseCount * 10;
  let attempts = 0;

  while (oresPlaced < baseCount && attempts < maxAttempts) {
    attempts++;

    let localX: number;
    let localZ: number;
    let selectedType: string;

    if (oreConfig.veins && veinCenters.length > 0) {
      // Pick a random vein center and scatter around it
      const vein = veinCenters[Math.floor(rng() * veinCenters.length)];
      const scatterRadius = oreConfig.veinSize! * 2;
      const angle = rng() * Math.PI * 2;
      const distance = rng() * scatterRadius;
      localX = vein.x + Math.cos(angle) * distance;
      localZ = vein.z + Math.sin(angle) * distance;
      selectedType = vein.oreType;
    } else {
      // Uniform random placement with weighted ore selection
      localX = rng() * ctx.tileSize;
      localZ = rng() * ctx.tileSize;

      // Select ore type based on distribution
      selectedType = oreTypes[0];
      const roll = rng() * totalWeight;
      let cumulative = 0;
      for (const oreType of oreTypes) {
        cumulative += distribution[oreType];
        if (roll < cumulative) {
          selectedType = oreType;
          break;
        }
      }
    }

    // Clamp to tile bounds
    localX = Math.max(0, Math.min(ctx.tileSize, localX));
    localZ = Math.max(0, Math.min(ctx.tileSize, localZ));

    // Convert to world coordinates for height lookup
    const worldX = ctx.tileX * ctx.tileSize + localX;
    const worldZ = ctx.tileZ * ctx.tileSize + localZ;
    const height = ctx.getHeightAt(worldX, worldZ);

    // Skip if underwater (ocean or river/pond)
    if (height < ctx.waterThreshold) {
      continue;
    }
    if (ctx.getWaterSurfaceAt) {
      const waterY = ctx.getWaterSurfaceAt(worldX, worldZ);
      if (height <= waterY + 1.0) continue; // 1m buffer above water surface
    }

    // Check minimum spacing
    let tooClose = false;
    for (const pos of placedPositions) {
      const dx = localX - pos.x;
      const dz = localZ - pos.z;
      if (dx * dx + dz * dz < minSpacingSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Check if on road
    if (ctx.isOnRoad?.(worldX, worldZ)) {
      continue;
    }

    // Extract ore subtype: "ore_copper" -> "copper"
    const oreSubType = selectedType.replace("ore_", "");

    // Generate random scale within variation range
    const [minScale, maxScale] = oreConfig.scaleVariation ?? [0.9, 1.1];
    const scale = minScale + rng() * (maxScale - minScale);

    // Generate random Y-axis rotation
    const rotation = rng() * Math.PI * 2;

    // Create resource node
    const resource: ResourceNode = {
      id: `${ctx.tileKey}_ore_${oresPlaced}`,
      type: "ore",
      subType: oreSubType as ResourceSubType,
      position: { x: localX, y: height, z: localZ },
      mesh: null,
      health: 100,
      maxHealth: 100,
      respawnTime: 300000, // 5 minutes
      harvestable: true,
      requiredLevel: getOreLevelRequirement(oreSubType),
      scale,
      rotation,
    };

    resources.push(resource);
    placedPositions.push({ x: localX, z: localZ });
    oresPlaced++;
  }

  return resources;
}

// ============================================================================
// DECORATIVE ROCK GENERATION
// ============================================================================

/**
 * Default rock presets mapping for each biome type.
 * Used when no specific distribution is provided.
 */
export const ROCK_BIOME_DEFAULTS: Record<
  string,
  { presets: string[]; distribution: Record<string, number> }
> = {
  tundra: {
    presets: ["granite", "basalt", "boulder"],
    distribution: { granite: 2, basalt: 2, boulder: 2 },
  },
  forest: {
    presets: ["boulder", "granite", "limestone"],
    distribution: { boulder: 3, granite: 2, limestone: 1 },
  },
  canyon: {
    presets: ["sandstone", "limestone", "pebble"],
    distribution: { sandstone: 4, limestone: 2, pebble: 1 },
  },
};

/**
 * Get rock presets and distribution for a biome type.
 */
export function getRockPresetsForBiome(biomeType: string): {
  presets: string[];
  distribution: Record<string, number>;
} {
  return (
    ROCK_BIOME_DEFAULTS[biomeType.toLowerCase()] ?? ROCK_BIOME_DEFAULTS.forest
  );
}

/**
 * Generate decorative rocks for a tile based on biome configuration.
 * These are non-harvestable environmental rocks for visual variety.
 *
 * @param ctx - Resource generation context from TerrainSystem
 * @param rockConfig - Biome rock configuration
 * @param biomeType - Biome type for default presets
 * @returns Array of VegetationInstance objects for rocks
 */
export function generateRocks(
  ctx: ResourceGenerationContext,
  rockConfig: BiomeRockConfig,
  biomeType: string,
): VegetationInstance[] {
  if (!rockConfig.enabled) {
    return [];
  }

  const rocks: VegetationInstance[] = [];

  // Calculate rock count based on density and tile size
  const tileArea = (ctx.tileSize / 100) * (ctx.tileSize / 100);
  const baseCount = Math.floor(rockConfig.density * tileArea);

  if (baseCount === 0) {
    return [];
  }

  // Use deterministic RNG
  const rng = ctx.createRng("rocks");

  // Get presets and distribution
  const presets =
    rockConfig.presets.length > 0
      ? rockConfig.presets
      : getRockPresetsForBiome(biomeType).presets;

  const distribution =
    rockConfig.distribution ?? getRockPresetsForBiome(biomeType).distribution;

  if (presets.length === 0) {
    return [];
  }

  const totalWeight = presets.reduce(
    (sum, p) => sum + (distribution[p] ?? 1),
    0,
  );
  if (totalWeight === 0) {
    return [];
  }

  // Track placed positions for spacing
  const placedPositions: Array<{ x: number; z: number }> = [];
  const minSpacing = rockConfig.minSpacing;
  const minSpacingSq = minSpacing * minSpacing;

  // Generate cluster centers if clustering enabled
  const clusterCenters: Array<{ x: number; z: number }> = [];
  const clusterChance = rockConfig.clusterChance ?? 0.3;
  const [clusterMin, clusterMax] = rockConfig.clusterSize ?? [3, 6];

  if (clusterChance > 0) {
    const numClusters = Math.ceil(baseCount / ((clusterMin + clusterMax) / 2));
    for (let i = 0; i < numClusters; i++) {
      if (rng() < clusterChance) {
        clusterCenters.push({
          x: rng() * ctx.tileSize,
          z: rng() * ctx.tileSize,
        });
      }
    }
  }

  let rocksPlaced = 0;
  const maxAttempts = baseCount * 15;
  let attempts = 0;

  while (rocksPlaced < baseCount && attempts < maxAttempts) {
    attempts++;

    let localX: number;
    let localZ: number;

    // Decide if this rock should be in a cluster
    const useCluster = clusterCenters.length > 0 && rng() < 0.6;

    if (useCluster) {
      const cluster = clusterCenters[Math.floor(rng() * clusterCenters.length)];
      const scatterRadius = 5 + rng() * 10; // 5-15m scatter
      const angle = rng() * Math.PI * 2;
      const distance = rng() * scatterRadius;
      localX = cluster.x + Math.cos(angle) * distance;
      localZ = cluster.z + Math.sin(angle) * distance;
    } else {
      localX = rng() * ctx.tileSize;
      localZ = rng() * ctx.tileSize;
    }

    // Clamp to tile bounds
    localX = Math.max(0, Math.min(ctx.tileSize, localX));
    localZ = Math.max(0, Math.min(ctx.tileSize, localZ));

    // Convert to world coordinates for height lookup
    const worldX = ctx.tileX * ctx.tileSize + localX;
    const worldZ = ctx.tileZ * ctx.tileSize + localZ;
    const height = ctx.getHeightAt(worldX, worldZ);

    // Skip if underwater (ocean or river/pond)
    if (height < ctx.waterThreshold) {
      continue;
    }
    if (ctx.getWaterSurfaceAt) {
      const waterY = ctx.getWaterSurfaceAt(worldX, worldZ);
      if (height <= waterY + 1.0) continue; // 1m buffer above water surface
    }

    // Check minimum spacing
    let tooClose = false;
    for (const pos of placedPositions) {
      const dx = localX - pos.x;
      const dz = localZ - pos.z;
      if (dx * dx + dz * dz < minSpacingSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Check if on road
    if (ctx.isOnRoad?.(worldX, worldZ)) {
      continue;
    }

    // Select preset based on weighted distribution
    let selectedPreset = presets[0];
    const roll = rng() * totalWeight;
    let cumulative = 0;
    for (const preset of presets) {
      cumulative += distribution[preset] ?? 1;
      if (roll < cumulative) {
        selectedPreset = preset;
        break;
      }
    }

    // Generate random scale within range
    const [minScale, maxScale] = rockConfig.scaleRange;
    const scale = minScale + rng() * (maxScale - minScale);

    // Generate random Y-axis rotation
    const rotation = rng() * Math.PI * 2;

    // Create vegetation instance for rock
    const rock: VegetationInstance = {
      id: `${ctx.tileKey}_rock_${rocksPlaced}`,
      assetId: selectedPreset,
      category: "rock",
      position: { x: worldX, y: height, z: worldZ },
      rotation: { x: 0, y: rotation, z: 0 },
      scale,
      tileKey: ctx.tileKey,
    };

    rocks.push(rock);
    placedPositions.push({ x: localX, z: localZ });
    rocksPlaced++;
  }

  return rocks;
}

// ============================================================================
// DECORATIVE PLANT GENERATION
// ============================================================================

/**
 * Default plant presets mapping for each biome type.
 */
export const PLANT_BIOME_DEFAULTS: Record<
  string,
  { presets: string[]; distribution: Record<string, number> }
> = {
  tundra: {
    presets: ["bergenia", "pulmonaria"],
    distribution: { bergenia: 2, pulmonaria: 2 },
  },
  forest: {
    presets: ["monstera", "philodendron", "calathea", "ficus", "hosta"],
    distribution: {
      monstera: 2,
      philodendron: 2,
      calathea: 2,
      ficus: 1,
      hosta: 3,
    },
  },
  canyon: {
    presets: ["zamioculcas", "aglaonema", "syngonium"],
    distribution: { zamioculcas: 3, aglaonema: 2, syngonium: 1 },
  },
};

/**
 * Get plant presets and distribution for a biome type.
 */
export function getPlantPresetsForBiome(biomeType: string): {
  presets: string[];
  distribution: Record<string, number>;
} {
  return (
    PLANT_BIOME_DEFAULTS[biomeType.toLowerCase()] ?? PLANT_BIOME_DEFAULTS.forest
  );
}

/**
 * Generate decorative plants for a tile based on biome configuration.
 * These are non-harvestable environmental plants for visual variety.
 *
 * @param ctx - Resource generation context from TerrainSystem
 * @param plantConfig - Biome plant configuration
 * @param biomeType - Biome type for default presets
 * @returns Array of VegetationInstance objects for plants
 */
export function generatePlants(
  ctx: ResourceGenerationContext,
  plantConfig: BiomePlantConfig,
  biomeType: string,
): VegetationInstance[] {
  if (!plantConfig.enabled) {
    return [];
  }

  const plants: VegetationInstance[] = [];

  // Calculate plant count based on density and tile size
  const tileArea = (ctx.tileSize / 100) * (ctx.tileSize / 100);
  const baseCount = Math.floor(plantConfig.density * tileArea);

  if (baseCount === 0) {
    return [];
  }

  // Use deterministic RNG
  const rng = ctx.createRng("plants");

  // Get presets and distribution
  const presets =
    plantConfig.presets.length > 0
      ? plantConfig.presets
      : getPlantPresetsForBiome(biomeType).presets;

  const distribution =
    plantConfig.distribution ?? getPlantPresetsForBiome(biomeType).distribution;

  if (presets.length === 0) {
    return [];
  }

  const totalWeight = presets.reduce(
    (sum, p) => sum + (distribution[p] ?? 1),
    0,
  );
  if (totalWeight === 0) {
    return [];
  }

  // Track placed positions for spacing
  const placedPositions: Array<{ x: number; z: number }> = [];
  const minSpacing = plantConfig.minSpacing;
  const minSpacingSq = minSpacing * minSpacing;

  // Generate cluster centers if clustering enabled
  const clusterCenters: Array<{ x: number; z: number }> = [];
  if (plantConfig.clustering) {
    const [clusterMin, clusterMax] = plantConfig.clusterSize ?? [2, 4];
    const numClusters = Math.ceil(baseCount / ((clusterMin + clusterMax) / 2));
    for (let i = 0; i < numClusters; i++) {
      clusterCenters.push({
        x: rng() * ctx.tileSize,
        z: rng() * ctx.tileSize,
      });
    }
  }

  let plantsPlaced = 0;
  const maxAttempts = baseCount * 15;
  let attempts = 0;

  while (plantsPlaced < baseCount && attempts < maxAttempts) {
    attempts++;

    let localX: number;
    let localZ: number;

    const useCluster = clusterCenters.length > 0 && rng() < 0.7;

    if (useCluster) {
      const cluster = clusterCenters[Math.floor(rng() * clusterCenters.length)];
      const scatterRadius = 3 + rng() * 6; // 3-9m scatter (plants cluster tighter)
      const angle = rng() * Math.PI * 2;
      const distance = rng() * scatterRadius;
      localX = cluster.x + Math.cos(angle) * distance;
      localZ = cluster.z + Math.sin(angle) * distance;
    } else {
      localX = rng() * ctx.tileSize;
      localZ = rng() * ctx.tileSize;
    }

    // Clamp to tile bounds
    localX = Math.max(0, Math.min(ctx.tileSize, localX));
    localZ = Math.max(0, Math.min(ctx.tileSize, localZ));

    // Convert to world coordinates for height lookup
    const worldX = ctx.tileX * ctx.tileSize + localX;
    const worldZ = ctx.tileZ * ctx.tileSize + localZ;
    const height = ctx.getHeightAt(worldX, worldZ);

    // Skip if underwater (ocean or river/pond)
    if (height < ctx.waterThreshold) {
      continue;
    }
    if (ctx.getWaterSurfaceAt) {
      const waterY = ctx.getWaterSurfaceAt(worldX, worldZ);
      if (height <= waterY + 1.0) continue; // 1m buffer above water surface
    }

    // Check minimum spacing
    let tooClose = false;
    for (const pos of placedPositions) {
      const dx = localX - pos.x;
      const dz = localZ - pos.z;
      if (dx * dx + dz * dz < minSpacingSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Check if on road
    if (ctx.isOnRoad?.(worldX, worldZ)) {
      continue;
    }

    // Select preset based on weighted distribution
    let selectedPreset = presets[0];
    const roll = rng() * totalWeight;
    let cumulative = 0;
    for (const preset of presets) {
      cumulative += distribution[preset] ?? 1;
      if (roll < cumulative) {
        selectedPreset = preset;
        break;
      }
    }

    // Generate random scale within range
    const [minScale, maxScale] = plantConfig.scaleRange;
    const scale = minScale + rng() * (maxScale - minScale);

    // Generate random Y-axis rotation
    const rotation = rng() * Math.PI * 2;

    // Create vegetation instance for plant
    const plant: VegetationInstance = {
      id: `${ctx.tileKey}_plant_${plantsPlaced}`,
      assetId: selectedPreset,
      category: "plant",
      position: { x: worldX, y: height, z: worldZ },
      rotation: { x: 0, y: rotation, z: 0 },
      scale,
      tileKey: ctx.tileKey,
    };

    plants.push(plant);
    placedPositions.push({ x: localX, z: localZ });
    plantsPlaced++;
  }

  return plants;
}
