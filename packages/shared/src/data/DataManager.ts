/**
 * Data Manager - Centralized Content Database
 *
 * Provides a single point of access to all externalized data including:
 * - Items and equipment
 * - NPCs (categorized as: mob, boss, neutral, quest)
 * - World areas and spawn points
 * - Treasure locations
 * - Banks and stores
 * - Starting items and equipment requirements
 *
 * This system validates data on load and provides type-safe access methods.
 *
 * NPC Categories:
 * - mob: Combat NPCs (goblins, bandits, guards)
 * - boss: Powerful special combat encounters
 * - neutral: Non-combat NPCs (shopkeepers, bank clerks)
 * - quest: Quest-related NPCs (quest givers, quest objectives)
 */

import { BANKS, GENERAL_STORES } from "./banks-stores";
import { ITEMS } from "./items";
import { ALL_NPCS } from "./npcs";
import { COMBAT_CONSTANTS } from "../constants/CombatConstants";
import { generateAllNotedItems } from "./NoteGenerator";
import {
  ALL_WORLD_AREAS,
  STARTER_TOWNS,
  getMobSpawnsInArea,
  getNPCsInArea,
} from "./world-areas";
import { BIOMES } from "./world-structure";
import { validateAuthoredResourceIdentities } from "./ResourceInstanceIdentity";
import { validateCompactResourceGroves } from "../systems/shared/world/CompactResourceGroves";
import { validateCompactPreparationLodge } from "../systems/shared/world/CompactPreparationLodge";
import {
  validateCompactServiceCourt,
  validateCompactServicePlanting,
} from "../systems/shared/world/CompactServiceCourt";
import { validateCompactLandscapeRocks } from "../systems/shared/world/CompactLandscapeRocks";
import {
  canonicalWorldJson,
  WorldManifestIdentityBuilder,
} from "./WorldContentIdentity";
import {
  resolveWorldTerrainProfile,
  type WorldTerrainProfile,
} from "../systems/shared/world/WorldTerrainProfile";
import { loadSkillUnlocks, type SkillUnlocksManifest } from "./skill-unlocks";
import {
  TierDataProvider,
  loadTierRequirements,
  type TierRequirementsManifest,
  type TierableItem,
} from "./TierDataProvider";
import {
  processingDataProvider,
  type CookingManifest,
  type FiremakingManifest,
  type SmeltingManifest,
  type SmithingManifest,
  type CraftingManifest,
  type TanningManifest,
  type FletchingManifest,
  type RunecraftingManifest,
} from "./ProcessingDataProvider";
import {
  stationDataProvider,
  type StationsManifest,
  type ModelBoundsManifest,
} from "./StationDataProvider";
import { prayerDataProvider, type PrayersManifest } from "./PrayerDataProvider";
import { DEFAULT_AVATAR_URL, getDuelAvatarUrlForStyle } from "./avatars";
import {
  isExternalValueEnabled,
  validateExternalValueWorldAreaSafety,
  validatePreparationDeathCustodyAreas,
} from "../systems/shared/death/PreparationDeathCustodyPolicy";

// Define constants from JSON data
const STARTING_ITEMS: Array<{ id: string }> = []; // Stub - data removed
const TREASURE_LOCATIONS: TreasureLocation[] = []; // Stub - data removed

// Core item category files required for startup-safe gameplay.
// If any of these are missing, DataManager falls back to legacy items.json.
const REQUIRED_ITEM_FILES = [
  "weapons",
  "tools",
  "resources",
  "food",
  "misc",
] as const;

// Optional categories: load when available, but do not fail startup if absent.
// Some CDN environments still serve only the core category set.
const OPTIONAL_ITEM_FILES = ["ammunition", "runes", "armor"] as const;

const ITEM_CATEGORY_FILES = [...REQUIRED_ITEM_FILES, ...OPTIONAL_ITEM_FILES];
const OPTIONAL_DATA_WARNINGS_ENABLED =
  process.env.DATA_OPTIONAL_MANIFEST_WARNINGS !== "false";
const getAllTreasureLocations = () => TREASURE_LOCATIONS;
const getTreasureLocationsByDifficulty = (_difficulty: number) =>
  TREASURE_LOCATIONS;

function warnOptionalData(message: string): void {
  if (!OPTIONAL_DATA_WARNINGS_ENABLED) return;
  console.warn(message);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Used only after descriptor-validated JSON copying, never on caller objects. */
function freezeWorldConfig<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeWorldConfig(child);
    Object.freeze(value);
  }
  return value;
}

function isBuildingsManifest(value: unknown): value is BuildingsManifest {
  if (!isObjectRecord(value)) return false;

  return (
    typeof value.version === "number" &&
    Array.isArray(value.towns) &&
    isObjectRecord(value.buildingTypes) &&
    isObjectRecord(value.sizeDefinitions)
  );
}

type BrowserDataWindow = Window & {
  __CDN_URL?: string;
  __ASSETS_URL?: string;
};

function getClientAssetsBaseUrl(): string {
  let cdnUrl =
    process.env.PUBLIC_CDN_URL || "http://localhost:5555/game-assets";

  if (typeof window !== "undefined") {
    const windowWithCdn = window as BrowserDataWindow;
    if (windowWithCdn.__ASSETS_URL) {
      cdnUrl = windowWithCdn.__ASSETS_URL;
    } else if (windowWithCdn.__CDN_URL) {
      cdnUrl = windowWithCdn.__CDN_URL;
    } else if (
      typeof import.meta !== "undefined" &&
      import.meta.env?.PUBLIC_CDN_URL
    ) {
      cdnUrl =
        import.meta.env.PUBLIC_CDN_URL || "http://localhost:5555/game-assets";
    }
  }

  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.PUBLIC_CDN_URL &&
    !cdnUrl.includes("localhost")
  ) {
    cdnUrl = process.env.PUBLIC_CDN_URL;
  }

  return cdnUrl;
}

async function fetchRequiredJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `${label} returned unexpected content-type: ${contentType}`,
    );
  }

  return (await response.json()) as T;
}

async function fetchOptionalJson<T>(
  url: string,
  label: string,
): Promise<{ found: false } | { found: true; value: T }> {
  const response = await fetch(url);
  if (response.status === 404) return { found: false };
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `${label} returned unexpected content-type: ${contentType}`,
    );
  }

  return { found: true, value: (await response.json()) as T };
}

const NPC_MODEL_ARCHETYPES: Record<NPCModelArchetype, string> = {
  // Use GLB version (323KB) instead of VRM (8.7MB) to avoid base64 buffer parsing issues
  goblin: "asset://models/goblin/goblin_rigged.glb",
  human: DEFAULT_AVATAR_URL,
  thug: getDuelAvatarUrlForStyle("melee", 1),
  troll: getDuelAvatarUrlForStyle("melee", 0),
  imp: "asset://models/goblin/goblin_rigged.glb",
};

import type {
  Item,
  NPCData,
  NPCDataInput,
  NPCCategory,
  NPCModelArchetype,
  LevelRange,
  TreasureLocation,
  StoreData,
  BiomeData,
} from "../types/core/core";
import type { DataValidationResult } from "../types/core/validation-types";
import type { MobSpawnPoint, NPCLocation, WorldArea } from "./world-areas";
import { WeaponType, EquipmentSlotName, AttackType } from "../types/core/core";
import type {
  WorldConfigManifest,
  BuildingsManifest,
} from "../types/world/world-types";

/**
 * Gathering Tool Data - derived from items.json where item.tool is defined
 * Defines tool properties for gathering skills (woodcutting, mining, fishing)
 *
 * classic MMORPG Mechanics:
 * - Woodcutting: tier used for success rate lookup, roll frequency is fixed (4 ticks)
 * - Mining: rollTicks defines time between attempts, success is level-only
 * - Fishing: equipment doesn't affect speed or success
 */
export interface GatheringToolData {
  /** Item ID matching inventory items (e.g., "bronze_hatchet") */
  itemId: string;
  /** Gathering skill this tool is used for */
  skill: "woodcutting" | "mining" | "fishing";
  /** Metal tier for success rate lookup (e.g., "bronze", "dragon") */
  tier: string;
  /** Skill level required to use this tool (derived from tier or explicit) */
  levelRequired: number;
  /** For mining: ticks between roll attempts (rules-accurate) */
  rollTicks?: number;
  /**
   * For mining (dragon/crystal pickaxe): Chance for bonus speed roll.
   * classic MMORPG: Dragon has 1/6 (0.167), Crystal has 1/4 (0.25) chance for 2-tick roll.
   */
  bonusTickChance?: number;
  /**
   * For mining (dragon/crystal pickaxe): Tick count when bonus triggers.
   * classic MMORPG: Both use 2 ticks when bonus triggers (vs normal 3).
   */
  bonusRollTicks?: number;
  /** Priority for best tool selection (lower = better, 1 = best) */
  priority: number;
}

/**
 * Tool data embedded in items.json
 */
export interface ItemToolData {
  skill: "woodcutting" | "mining" | "fishing";
  priority: number;
  rollTicks?: number;
}

/**
 * External Resource Data - loaded from gathering/*.json manifests
 * Used by ResourceSystem for trees, ores, and fishing spots.
 */
export interface ExternalResourceData {
  id: string;
  name: string;
  type: string;
  examine?: string;
  modelPath: string | null;
  /** LOD1 model path for medium distance rendering */
  lod1ModelPath?: string | null;
  /** LOD2 model path for far distance rendering */
  lod2ModelPath?: string | null;
  depletedModelPath: string | null;
  /**
   * Procgen preset name for procedural tree generation.
   * Maps to @hyperforge/procgen presets (e.g., "blackOak", "weepingWillow").
   * If specified, runtime procedural generation will be used instead of GLB model.
   */
  procgenPreset?: string;
  /** Multiple GLB model paths for visual variation (hash-picked per instance) */
  modelVariants?: string[];
  scale: number;
  depletedScale: number;
  harvestSkill: string;
  toolRequired: string | null;
  /** Secondary consumable required (e.g., "fishing_bait", "feathers") */
  secondaryRequired?: string;
  levelRequired: number;
  baseCycleTicks: number;
  depleteChance: number;
  respawnTicks: number;
  harvestYield: Array<{
    itemId: string;
    itemName: string;
    quantity: number;
    chance: number;
    xpAmount: number;
    stackable: boolean;
    /** Level required to catch this specific fish (rules-accurate) */
    levelRequired?: number;
    /** classic MMORPG catch rate at level 1 (x/256) - for priority rolling */
    catchLow?: number;
    /** classic MMORPG catch rate at level 99 (x/256) - for priority rolling */
    catchHigh?: number;
  }>;
}

/**
 * Woodcutting manifest structure - gathering/woodcutting.json
 */
export interface WoodcuttingManifest {
  trees: ExternalResourceData[];
}

/**
 * Mining manifest structure - gathering/mining.json
 */
export interface MiningManifest {
  rocks: ExternalResourceData[];
}

/**
 * Fishing manifest structure - gathering/fishing.json
 */
export interface FishingManifest {
  spots: ExternalResourceData[];
}

/**
 * Centralized Data Manager
 */
export class DataManager {
  private static instance: DataManager;
  private isInitialized = false;
  private initialization: Promise<DataValidationResult> | null = null;
  private validationResult: DataValidationResult | null = null;
  private worldAssetsDir: string | null = null;
  private static worldConfig: WorldConfigManifest | null = null;
  private static buildingsManifest: BuildingsManifest | null = null;
  private worldIdentityBuilder = new WorldManifestIdentityBuilder();
  private static worldContentIdentity: string | null = null;
  private static worldTerrainProfile: WorldTerrainProfile | null = null;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the loaded world configuration manifest
   * Returns null if not yet loaded
   */
  public static getWorldConfig(): WorldConfigManifest | null {
    return DataManager.worldConfig;
  }

  /**
   * Admit startup configuration. An identified running world cannot hot-swap it.
   */
  public static setWorldConfig(config: WorldConfigManifest): void {
    // Copy descriptor-validated JSON before reading fields: callers cannot use
    // accessors or mutate the stored terrain after identity admission.
    const copy = JSON.parse(canonicalWorldJson(config)) as WorldConfigManifest;
    if (
      !isObjectRecord(copy) ||
      !isObjectRecord(copy.terrain) ||
      !isObjectRecord(copy.towns) ||
      !isObjectRecord(copy.roads)
    )
      throw new Error(
        "World configuration requires terrain, towns and roads objects",
      );
    if (
      !Number.isSafeInteger(copy.version) ||
      copy.version < 1 ||
      !Number.isSafeInteger(copy.terrain.worldSize) ||
      copy.terrain.worldSize < 1
    )
      throw new Error(
        "World configuration requires a positive integer version and world size",
      );
    if (
      !Number.isSafeInteger(copy.terrain.tileResolution) ||
      copy.terrain.tileResolution < 2 ||
      copy.terrain.tileResolution > 256
    )
      throw new Error(
        "World configuration tileResolution must be an integer in 2..256",
      );
    const profile = resolveWorldTerrainProfile(copy.terrainProfile);
    const compactResourceGroves = validateCompactResourceGroves(
      copy.compactResourceGroves,
      profile,
      copy.version,
    );
    const compactPreparationLodge = validateCompactPreparationLodge(
      copy.compactPreparationLodge,
      profile,
    );
    const compactServiceCourt = validateCompactServiceCourt(
      copy.compactServiceCourt,
      profile,
    );
    const compactServicePlanting = validateCompactServicePlanting(
      copy.compactServicePlanting,
      profile,
      compactServiceCourt,
    );
    const compactLandscapeRocks = validateCompactLandscapeRocks(
      copy.compactLandscapeRocks,
      profile,
    );
    config = copy;
    if (
      config.seed !== profile.seed ||
      config.terrain.tileSize !== profile.terrainTileSize ||
      config.terrain.maxHeight !== profile.height.maxHeightParameter ||
      config.terrain.waterThreshold !== profile.water.threshold ||
      config.terrain.worldSize * profile.terrainTileSize !==
        profile.bounds.maxX - profile.bounds.minX ||
      config.terrain.worldSize * profile.terrainTileSize !==
        profile.bounds.maxZ - profile.bounds.minZ
    ) {
      throw new Error("World configuration conflicts with its terrain profile");
    }
    const normalized = freezeWorldConfig({
      ...config,
      terrainProfile: profile,
      ...(compactResourceGroves ? { compactResourceGroves } : {}),
      ...(compactPreparationLodge ? { compactPreparationLodge } : {}),
      ...(compactServiceCourt ? { compactServiceCourt } : {}),
      ...(compactServicePlanting ? { compactServicePlanting } : {}),
      ...(compactLandscapeRocks ? { compactLandscapeRocks } : {}),
    });
    if (DataManager.worldContentIdentity !== null) {
      if (
        canonicalWorldJson(DataManager.worldConfig) !==
        canonicalWorldJson(normalized)
      )
        throw new Error(
          "An identified world cannot change configuration without a fresh startup",
        );
      return;
    }
    DataManager.worldConfig = normalized;
    DataManager.worldTerrainProfile = profile;
    DataManager.worldContentIdentity = null;
  }

  public static getWorldTerrainProfile(): WorldTerrainProfile {
    if (!DataManager.worldTerrainProfile)
      throw new Error("World terrain profile is not initialized");
    return DataManager.worldTerrainProfile;
  }

  public static getWorldContentIdentity(): string {
    if (!DataManager.worldContentIdentity)
      throw new Error("World content identity is not initialized");
    return DataManager.worldContentIdentity;
  }

  /**
   * Get the loaded buildings manifest
   * Returns null if not yet loaded
   */
  public static getBuildingsManifest(): BuildingsManifest | null {
    return DataManager.buildingsManifest;
  }

  /**
   * Admit buildings before readiness; identified worlds cannot hot-swap content.
   */
  public static setBuildingsManifest(manifest: BuildingsManifest): void {
    const copy = JSON.parse(canonicalWorldJson(manifest)) as unknown;
    if (!isBuildingsManifest(copy))
      throw new Error("Invalid buildings manifest shape");
    if (DataManager.worldContentIdentity !== null) {
      if (
        canonicalWorldJson(DataManager.buildingsManifest) !==
        canonicalWorldJson(copy)
      )
        throw new Error(
          "An identified world cannot change buildings without a fresh startup",
        );
      return;
    }
    DataManager.buildingsManifest = freezeWorldConfig(copy);
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): DataManager {
    if (!DataManager.instance) {
      DataManager.instance = new DataManager();
    }
    return DataManager.instance;
  }

  /**
   * Load manifests from CDN (client) or filesystem (server)
   */
  private async loadManifestsFromCDN(): Promise<void> {
    // On server (Node.js or Bun), load from filesystem since HTTP server isn't up yet
    // Check for runtime-specific globals that don't exist in browsers
    const isServer =
      typeof process !== "undefined" &&
      process.versions !== undefined &&
      (process.versions.node !== undefined ||
        (process.versions as { bun?: string }).bun !== undefined);

    if (isServer) {
      await this.loadManifestsFromFilesystem();
      return;
    }

    // Client: Load from CDN (localhost:5555/game-assets in dev, R2/S3 in prod)
    const cdnUrl = getClientAssetsBaseUrl();
    const baseUrl = `${cdnUrl}/manifests`;

    // In test/CI environments, CDN might not be available - make loading non-fatal
    const isTestEnv =
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.NODE_ENV === "test";

    try {
      // ── PHASE 1: Load tier-requirements + items (sequential dependency) ──
      // tier-requirements must load first because normalizeItem() uses tier data
      try {
        const tierReqManifest =
          await fetchRequiredJson<TierRequirementsManifest>(
            `${baseUrl}/tier-requirements.json`,
            "tier-requirements.json",
          );
        loadTierRequirements(tierReqManifest);
      } catch {
        console.warn(
          "[DataManager] tier-requirements.json not found, tier-based requirements unavailable",
        );
      }

      // Load items - prefer category files, fall back to legacy single-file manifest.
      let loadedFromDirectory = false;
      try {
        // Fetch all known category files in parallel.
        const responses = await Promise.all(
          ITEM_CATEGORY_FILES.map((file) =>
            fetch(`${baseUrl}/items/${file}.json`),
          ),
        );

        const missingRequired = REQUIRED_ITEM_FILES.filter((_, index) => {
          const response = responses[index];
          return !response || !response.ok;
        });

        // Only require core categories; optional categories can be absent.
        if (missingRequired.length === 0) {
          const seenIds = new Set<string>();

          for (let i = 0; i < ITEM_CATEGORY_FILES.length; i++) {
            const response = responses[i];
            const category = ITEM_CATEGORY_FILES[i];
            if (!response?.ok) {
              console.warn(
                `[DataManager] items/${category}.json not found on CDN, continuing without it`,
              );
              continue;
            }

            const items = (await response.json()) as Item[];
            for (const item of items) {
              if (seenIds.has(item.id)) {
                throw new Error(
                  `[DataManager] Duplicate item ID "${item.id}" in items/${category}.json`,
                );
              }
              seenIds.add(item.id);
              const normalized = this.normalizeItem(item);
              (ITEMS as Map<string, Item>).set(normalized.id, normalized);
            }
          }
          console.log(
            `[DataManager] Loaded ${seenIds.size} items from items/ directory`,
          );
          loadedFromDirectory = true;
        } else {
          console.warn(
            `[DataManager] Missing required CDN item categories (${missingRequired.join(", ")}), falling back to items.json`,
          );
        }
      } catch {
        // Directory loading failed - will fall back below
      }

      if (!loadedFromDirectory) {
        // Fallback: Load from single items.json (backwards compatibility)
        const itemsRes = await fetch(`${baseUrl}/items.json`);
        if (!itemsRes.ok) {
          throw new Error(
            `[DataManager] Failed to load items.json from CDN: HTTP ${itemsRes.status}`,
          );
        }
        const list = (await itemsRes.json()) as Array<Item>;
        for (const it of list) {
          const normalized = this.normalizeItem(it);
          (ITEMS as Map<string, Item>).set(normalized.id, normalized);
        }
      }

      // Generate noted variants for all eligible items
      // This auto-creates "{itemId}_noted" variants for tradeable, non-stackable items
      const itemsWithNotes = generateAllNotedItems(ITEMS);
      // Clear and repopulate ITEMS map with noted variants included
      (ITEMS as Map<string, Item>).clear();
      for (const [id, item] of itemsWithNotes) {
        (ITEMS as Map<string, Item>).set(id, item);
      }

      // ── PHASE 2: Load ALL remaining manifests in parallel ──
      // None of these depend on each other (except model-bounds → stations,
      // handled within the stations loader). Fire them all at once.
      const loadStart = performance.now();

      await Promise.allSettled([
        // NPCs
        (async () => {
          const npcList = await fetchRequiredJson<Array<NPCDataInput>>(
            `${baseUrl}/npcs.json`,
            "npcs.json",
          );
          for (const npc of npcList) {
            const normalized = this.normalizeNPC(npc);
            (ALL_NPCS as Map<string, NPCData>).set(normalized.id, normalized);
          }
          this.worldIdentityBuilder.record("npcs.json", npcList);
        })(),

        // World areas
        (async () => {
          const worldAreasData = await fetchRequiredJson<{
            starterTowns: Record<string, WorldArea>;
            level1Areas: Record<string, WorldArea>;
            level2Areas: Record<string, WorldArea>;
            level3Areas: Record<string, WorldArea>;
            specialAreas?: Record<string, WorldArea>;
          }>(`${baseUrl}/world-areas.json`, "world-areas.json");
          validateAuthoredResourceIdentities([
            worldAreasData.starterTowns,
            worldAreasData.level1Areas,
            worldAreasData.level2Areas,
            worldAreasData.level3Areas,
            worldAreasData.specialAreas,
          ]);
          Object.assign(
            ALL_WORLD_AREAS,
            worldAreasData.starterTowns,
            worldAreasData.level1Areas,
            worldAreasData.level2Areas,
            worldAreasData.level3Areas,
            worldAreasData.specialAreas || {},
          );
          Object.assign(STARTER_TOWNS, worldAreasData.starterTowns);
          this.worldIdentityBuilder.record("world-areas.json", worldAreasData);
        })(),

        // Biomes
        (async () => {
          const biomeList = await fetchRequiredJson<Array<BiomeData>>(
            `${baseUrl}/biomes.json`,
            "biomes.json",
          );
          for (const biome of biomeList) {
            BIOMES[biome.id] = biome;
          }
          this.worldIdentityBuilder.record("biomes.json", biomeList);
        })(),

        // World profile and arena layout are mandatory identity inputs. The
        // final identity build rejects failures even though optional loaders
        // in this phase use allSettled.
        (async () => {
          const config = await fetchRequiredJson<WorldConfigManifest>(
            `${baseUrl}/world-config.json`,
            "world-config.json",
          );
          DataManager.setWorldConfig(config);
          this.worldIdentityBuilder.record("world-config.json", config);
          const arenas = await fetchRequiredJson<unknown>(
            `${baseUrl}/duel-arenas.json`,
            "duel-arenas.json",
          );
          this.worldIdentityBuilder.record("duel-arenas.json", arenas);
        })(),

        // Buildings
        (async () => {
          DataManager.buildingsManifest = null;
          try {
            const buildingsData = await fetchOptionalJson<unknown>(
              `${baseUrl}/buildings.json`,
              "buildings.json",
            );
            if (buildingsData.found) {
              if (!isBuildingsManifest(buildingsData.value)) {
                throw new Error("Invalid buildings manifest shape");
              }
              DataManager.setBuildingsManifest(buildingsData.value);
              console.log(
                `[DataManager] Loaded buildings manifest: ${buildingsData.value.towns.length} pre-defined towns`,
              );
            }
            this.worldIdentityBuilder.record(
              "buildings.json",
              DataManager.buildingsManifest,
            );
          } catch (error) {
            warnOptionalData(
              `[DataManager] buildings.json failed; world identity will reject initialization (${error instanceof Error ? error.message : "unknown error"})`,
            );
          }
        })(),

        // Stores
        (async () => {
          const storeList = await fetchRequiredJson<Array<StoreData>>(
            `${baseUrl}/stores.json`,
            "stores.json",
          );
          for (const store of storeList) {
            GENERAL_STORES[store.id] = store;
          }
        })(),

        // Skill unlocks
        (async () => {
          try {
            const skillUnlocksManifest =
              await fetchRequiredJson<SkillUnlocksManifest>(
                `${baseUrl}/skill-unlocks.json`,
                "skill-unlocks.json",
              );
            loadSkillUnlocks(skillUnlocksManifest);
          } catch {
            console.warn(
              "[DataManager] skill-unlocks.json not available from CDN, skill guide will be empty",
            );
          }
        })(),

        // Gathering manifests (3 fetches, internally parallel)
        this.loadGatheringManifestsFromCDN(baseUrl),

        // Recipe manifests (8 fetches + prayers + model-bounds + stations, internally parallel)
        this.loadRecipeManifestsFromCDN(baseUrl),
      ]);

      console.log(
        `[DataManager] Phase 2 parallel load completed in ${(performance.now() - loadStart).toFixed(0)}ms`,
      );

      // Build EXTERNAL_TOOLS from items where item.tool is defined
      // This replaces the old tools.json loading
      this.buildToolsFromItems();
    } catch (error) {
      // In test/CI environments, CDN might not be available - this is non-fatal
      if (isTestEnv) {
        console.warn(
          "[DataManager] ⚠️  CDN not available in test environment - skipping manifest loading",
        );
        console.warn(
          "[DataManager] This is expected in CI/test - game data will use defaults",
        );
      } else {
        // In production/development, CDN should be available - log error and re-throw
        console.error(
          "[DataManager] ❌ Failed to load manifests from CDN:",
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Load manifests from filesystem (server-side only)
   * Uses packages/server/world/assets/manifests/ directory
   */
  private async loadManifestsFromFilesystem(): Promise<void> {
    const fsModuleId = "node:fs/promises";
    const pathModuleId = "node:path";
    const fs = (await import(
      /* @vite-ignore */ fsModuleId
    )) as typeof import("node:fs/promises");
    const path = (await import(
      /* @vite-ignore */ pathModuleId
    )) as typeof import("node:path");

    // Check if we're in a TEST environment where manifests might not exist
    // NOTE: CI=true is often set by CI/CD platforms AND production deployments (Railway)
    // Only skip manifest loading for actual test environments, not production CI/CD
    const isTestEnv =
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      (process.env.NODE_ENV === "test" || process.env.VITEST === "true");

    // Find manifests directory - assets are in packages/server/world/assets/
    // Resolve across multiple likely working directories to survive script/merge changes.
    const cwd = process.cwd();
    const candidateManifestsDirs: string[] = [];
    const pushCandidate = (dir: string | undefined): void => {
      if (!dir) return;
      const resolved = path.resolve(dir);
      if (!candidateManifestsDirs.includes(resolved)) {
        candidateManifestsDirs.push(resolved);
      }
    };

    const explicitAssetsDir = process.env.ASSETS_DIR;
    if (explicitAssetsDir) {
      pushCandidate(path.join(explicitAssetsDir, "manifests"));
    }

    // Resolve robustly via __dirname to support hoisting in monorepos/CI
    const parts = __dirname.split(path.sep);
    const packagesIndex = parts.lastIndexOf("packages");

    if (packagesIndex !== -1) {
      const rootDir = parts.slice(0, packagesIndex + 1).join(path.sep);
      pushCandidate(
        path.join(rootDir, "server", "world", "assets", "manifests"),
      );
    }

    // Common execution roots as fallbacks:
    pushCandidate(path.join(cwd, "world", "assets", "manifests"));
    pushCandidate(
      path.join(cwd, "packages", "server", "world", "assets", "manifests"),
    );
    pushCandidate(path.resolve(cwd, "..", "world", "assets", "manifests"));
    pushCandidate(
      path.resolve(cwd, "..", "..", "world", "assets", "manifests"),
    );

    let manifestsDir =
      candidateManifestsDirs[0] ||
      path.resolve(cwd, "packages", "server", "world", "assets", "manifests");

    let foundManifestsDir = false;
    for (const candidate of explicitAssetsDir
      ? candidateManifestsDirs.slice(0, 1)
      : candidateManifestsDirs) {
      try {
        await fs.access(candidate);
        manifestsDir = candidate;
        foundManifestsDir = true;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!candidateManifestsDirs.includes(manifestsDir)) {
      candidateManifestsDirs.push(manifestsDir);
    }

    if (!foundManifestsDir) {
      console.warn(
        `[DataManager] Could not verify manifests path from cwd=${cwd}. ` +
          `Tried: ${candidateManifestsDirs.join(", ")}. ` +
          `Proceeding with ${manifestsDir}. Set ASSETS_DIR to override.`,
      );
    }

    console.log(
      `[DataManager] Loading manifests from filesystem: ${manifestsDir}`,
    );

    try {
      // Load tier requirements FIRST - needed for normalizeItem to derive requirements from tier
      const tierReqPath = path.join(manifestsDir, "tier-requirements.json");
      try {
        const tierReqData = await fs.readFile(tierReqPath, "utf-8");
        const tierReqManifest = JSON.parse(
          tierReqData,
        ) as TierRequirementsManifest;
        loadTierRequirements(tierReqManifest);
      } catch {
        console.warn(
          "[DataManager] tier-requirements.json not found, tier-based requirements unavailable",
        );
      }

      // Load items - try directory first, fall back to single file
      const itemsDir = path.join(manifestsDir, "items");
      let loadedFromDirectory = false;

      try {
        await fs.access(itemsDir);
        // Directory exists - try to load from it (validates all required files)
        loadedFromDirectory = await this.loadItemsFromDirectory(
          fs,
          path,
          itemsDir,
        );
      } catch {
        // Directory doesn't exist - will fall back below
      }

      if (!loadedFromDirectory) {
        // Fallback: Load from single items.json (backwards compatibility)
        const itemsPath = path.join(manifestsDir, "items.json");
        const itemsData = await fs.readFile(itemsPath, "utf-8");
        const list = JSON.parse(itemsData) as Array<Item>;
        for (const it of list) {
          const normalized = this.normalizeItem(it);
          (ITEMS as Map<string, Item>).set(normalized.id, normalized);
        }
      }

      // Generate noted variants
      const itemsWithNotes = generateAllNotedItems(ITEMS);
      (ITEMS as Map<string, Item>).clear();
      for (const [id, item] of itemsWithNotes) {
        (ITEMS as Map<string, Item>).set(id, item);
      }

      // Load NPCs
      const npcsPath = path.join(manifestsDir, "npcs.json");
      const npcsData = await fs.readFile(npcsPath, "utf-8");
      const npcList = JSON.parse(npcsData) as Array<NPCDataInput>;
      for (const npc of npcList) {
        const normalized = this.normalizeNPC(npc);
        (ALL_NPCS as Map<string, NPCData>).set(normalized.id, normalized);
      }
      this.worldIdentityBuilder.record("npcs.json", npcList);

      // Load gathering resources from separate per-skill manifests
      // This matches the recipes/ pattern for organizational consistency
      await this.loadGatheringManifestsFromFilesystem(fs, path, manifestsDir);

      // Load world areas
      const worldAreasPath = path.join(manifestsDir, "world-areas.json");
      const worldAreasData = await fs.readFile(worldAreasPath, "utf-8");
      const worldAreas = JSON.parse(worldAreasData) as {
        starterTowns: Record<string, WorldArea>;
        level1Areas: Record<string, WorldArea>;
        level2Areas: Record<string, WorldArea>;
        level3Areas: Record<string, WorldArea>;
        specialAreas?: Record<string, WorldArea>;
      };
      // Merge all areas into ALL_WORLD_AREAS (including specialAreas like duel_arena)
      validateAuthoredResourceIdentities([
        worldAreas.starterTowns,
        worldAreas.level1Areas,
        worldAreas.level2Areas,
        worldAreas.level3Areas,
        worldAreas.specialAreas,
      ]);
      Object.assign(
        ALL_WORLD_AREAS,
        worldAreas.starterTowns,
        worldAreas.level1Areas,
        worldAreas.level2Areas,
        worldAreas.level3Areas,
        worldAreas.specialAreas || {},
      );
      Object.assign(STARTER_TOWNS, worldAreas.starterTowns);
      this.worldIdentityBuilder.record("world-areas.json", worldAreas);

      // Load biomes
      const biomesPath = path.join(manifestsDir, "biomes.json");
      const biomesData = await fs.readFile(biomesPath, "utf-8");
      const biomeList = JSON.parse(biomesData) as Array<BiomeData>;
      for (const biome of biomeList) {
        BIOMES[biome.id] = biome;
      }
      this.worldIdentityBuilder.record("biomes.json", biomeList);

      // Load world config manifest for terrain/town/road generation
      const worldConfigPath = path.join(manifestsDir, "world-config.json");
      const worldConfigData = await fs.readFile(worldConfigPath, "utf-8");
      const worldConfigManifest = JSON.parse(
        worldConfigData,
      ) as WorldConfigManifest;
      DataManager.setWorldConfig(worldConfigManifest);
      this.worldIdentityBuilder.record(
        "world-config.json",
        worldConfigManifest,
      );
      this.worldIdentityBuilder.record(
        "duel-arenas.json",
        JSON.parse(
          await fs.readFile(
            path.join(manifestsDir, "duel-arenas.json"),
            "utf-8",
          ),
        ),
      );

      // Load buildings manifest for pre-defined towns
      const buildingsPath = path.join(manifestsDir, "buildings.json");
      DataManager.buildingsManifest = null;
      try {
        const buildingsData = await fs.readFile(buildingsPath, "utf-8");
        const buildingsManifest = JSON.parse(buildingsData) as unknown;
        if (!isBuildingsManifest(buildingsManifest)) {
          throw new Error("Invalid buildings manifest shape");
        }
        DataManager.setBuildingsManifest(buildingsManifest);
        this.worldIdentityBuilder.record(
          "buildings.json",
          DataManager.buildingsManifest,
        );
        console.log(
          `[DataManager] Loaded buildings manifest: ${buildingsManifest.towns?.length ?? 0} pre-defined towns`,
        );
      } catch (error) {
        if (isObjectRecord(error) && error.code === "ENOENT") {
          this.worldIdentityBuilder.record("buildings.json", null);
        } else {
          throw error;
        }
        warnOptionalData(
          "[DataManager] buildings.json absent; recorded explicit absence in world identity",
        );
      }

      // Load stores
      const storesPath = path.join(manifestsDir, "stores.json");
      const storesData = await fs.readFile(storesPath, "utf-8");
      const storeList = JSON.parse(storesData) as Array<StoreData>;
      for (const store of storeList) {
        (GENERAL_STORES as Record<string, StoreData>)[store.id] = store;
      }

      // Load skill unlocks
      const skillUnlocksPath = path.join(manifestsDir, "skill-unlocks.json");
      try {
        const skillUnlocksData = await fs.readFile(skillUnlocksPath, "utf-8");
        const skillUnlocksManifest = JSON.parse(
          skillUnlocksData,
        ) as SkillUnlocksManifest;
        loadSkillUnlocks(skillUnlocksManifest);
      } catch {
        console.warn(
          "[DataManager] skill-unlocks.json not found, skill unlocks will be empty until loaded",
        );
      }

      // Load recipe manifests for ProcessingDataProvider
      await this.loadRecipeManifestsFromFilesystem(fs, path, manifestsDir);

      // Build EXTERNAL_TOOLS from items where item.tool is defined
      // This replaces the old tools.json loading
      this.buildToolsFromItems();

      // Count tools for logging
      const toolCount =
        (globalThis as { EXTERNAL_TOOLS?: Map<string, GatheringToolData> })
          .EXTERNAL_TOOLS?.size ?? 0;

      console.log(
        `[DataManager] ✅ Loaded manifests from filesystem (${(ITEMS as Map<string, Item>).size} items, ${(ALL_NPCS as Map<string, NPCData>).size} NPCs, ${Object.keys(BIOMES).length} biomes, ${toolCount} tools)`,
      );
    } catch (error) {
      // In test/CI environments, manifests might not exist - this is non-fatal
      if (isTestEnv) {
        console.warn(
          "[DataManager] ⚠️  Manifests not available in test/CI environment - skipping manifest loading",
        );
        console.warn(
          "[DataManager] This is expected in CI/test - game data will use defaults",
        );
      } else {
        // In production/development, manifests should exist - log error and re-throw
        console.error(
          "[DataManager] ❌ Failed to load manifests from filesystem:",
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Load external assets from CDN (works for both client and server)
   */
  private async loadExternalAssetsFromWorld(): Promise<void> {
    // Both client and server now load from CDN
    await this.loadManifestsFromCDN();
  }

  /**
   * Load items from items/ directory (multiple JSON files) - Filesystem version
   * Returns true if successful, false if should fall back to single file
   *
   * Validates core categories exist before loading. Optional categories are
   * loaded if present and skipped if absent.
   */
  private async loadItemsFromDirectory(
    fs: typeof import("fs/promises"),
    path: typeof import("path"),
    itemsDir: string,
  ): Promise<boolean> {
    // Validate core files exist before loading.
    for (const file of REQUIRED_ITEM_FILES) {
      const filePath = path.join(itemsDir, `${file}.json`);
      try {
        await fs.access(filePath);
      } catch {
        console.warn(
          `[DataManager] items/${file}.json not found, falling back to items.json`,
        );
        return false;
      }
    }

    // Core files exist - load all available categories.
    const seenIds = new Set<string>();

    for (const file of ITEM_CATEGORY_FILES) {
      const filePath = path.join(itemsDir, `${file}.json`);
      let data: string;
      try {
        data = await fs.readFile(filePath, "utf-8");
      } catch {
        if (
          REQUIRED_ITEM_FILES.includes(
            file as (typeof REQUIRED_ITEM_FILES)[number],
          )
        ) {
          throw new Error(
            `[DataManager] Required item file missing: items/${file}.json`,
          );
        }
        console.warn(
          `[DataManager] Optional items/${file}.json not found, continuing`,
        );
        continue;
      }
      const items = JSON.parse(data) as Array<Item>;

      for (const item of items) {
        // Duplicate ID check
        if (seenIds.has(item.id)) {
          throw new Error(
            `[DataManager] Duplicate item ID "${item.id}" found in items/${file}.json`,
          );
        }
        seenIds.add(item.id);

        const normalized = this.normalizeItem(item);
        (ITEMS as Map<string, Item>).set(normalized.id, normalized);
      }
    }

    console.log(
      `[DataManager] Loaded ${seenIds.size} items from items/ directory`,
    );
    return true;
  }

  private normalizeItem(item: Item): Item {
    // Ensure required fields have sane defaults and enums
    const normalizedWeaponType = String(item.weaponType ?? "")
      .trim()
      .toLowerCase();
    const safeWeaponType = Object.values(WeaponType).includes(
      normalizedWeaponType as WeaponType,
    )
      ? (normalizedWeaponType as WeaponType)
      : WeaponType.NONE;
    const equipSlot = item.equipSlot ?? null;
    const normalizedAttackType = String(item.attackType ?? "")
      .trim()
      .toLowerCase();
    const attackType = Object.values(AttackType).includes(
      normalizedAttackType as AttackType,
    )
      ? (normalizedAttackType as AttackType)
      : null;

    // Validate: weapons with equipSlot "weapon" should have equippedModelPath
    const equippedModelPath = item.equippedModelPath;
    if (equipSlot === "weapon" && equippedModelPath === undefined) {
      console.warn(
        `[DataManager] Weapon "${item.id}" missing equippedModelPath - will use convention fallback`,
      );
    }

    const equippedModelPathsByAvatar = item.equippedModelPathsByAvatar
      ? Object.fromEntries(
          Object.entries(item.equippedModelPathsByAvatar).map(
            ([avatarId, modelPath]) => {
              if (
                !/^[a-z0-9][a-z0-9-]*$/u.test(avatarId) ||
                typeof modelPath !== "string" ||
                !modelPath.startsWith("asset://") ||
                modelPath.includes("\\") ||
                modelPath.split("/").includes("..")
              ) {
                throw new Error(
                  `[DataManager] Item "${item.id}" has an invalid avatar-specific equipped model entry for "${avatarId}"`,
                );
              }
              return [avatarId, modelPath];
            },
          ),
        )
      : undefined;

    const gatheringModelPathsByAvatar = item.gatheringModelPathsByAvatar
      ? Object.fromEntries(
          Object.entries(item.gatheringModelPathsByAvatar).map(
            ([avatarId, modelPath]) => {
              if (
                !/^[a-z0-9][a-z0-9-]*$/u.test(avatarId) ||
                typeof modelPath !== "string" ||
                !modelPath.startsWith("asset://") ||
                modelPath.includes("\\") ||
                modelPath.split("/").includes("..")
              ) {
                throw new Error(
                  `[DataManager] Item "${item.id}" has an invalid avatar-specific gathering model entry for "${avatarId}"`,
                );
              }
              return [avatarId, modelPath];
            },
          ),
        )
      : undefined;

    const normalizeContentHash = (
      value: string | undefined,
      label: string,
    ): string | undefined => {
      if (value === undefined) return undefined;
      if (!/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error(
          `[DataManager] Item "${item.id}" has an invalid ${label} SHA-256`,
        );
      }
      return value;
    };
    const normalizeAvatarContentHashes = (
      hashes: Record<string, string> | undefined,
      paths: Record<string, string> | undefined,
      label: string,
    ): Record<string, string> | undefined =>
      hashes
        ? Object.fromEntries(
            Object.entries(hashes).map(([avatarId, hash]) => {
              if (!paths?.[avatarId]) {
                throw new Error(
                  `[DataManager] Item "${item.id}" has a ${label} SHA-256 without a matching model for "${avatarId}"`,
                );
              }
              const normalizedHash = normalizeContentHash(
                hash,
                `${label} "${avatarId}"`,
              );
              if (!normalizedHash) {
                throw new Error(
                  `[DataManager] Item "${item.id}" is missing a ${label} SHA-256 for "${avatarId}"`,
                );
              }
              return [avatarId, normalizedHash];
            }),
          )
        : undefined;
    const equippedModelSha256 = normalizeContentHash(
      item.equippedModelSha256,
      "equipped model",
    );
    const equippedModelSha256ByAvatar = normalizeAvatarContentHashes(
      item.equippedModelSha256ByAvatar,
      equippedModelPathsByAvatar,
      "avatar-specific equipped model",
    );
    const gatheringModelSha256ByAvatar = normalizeAvatarContentHashes(
      item.gatheringModelSha256ByAvatar,
      gatheringModelPathsByAvatar,
      "avatar-specific gathering model",
    );

    // Derive requirements from tier if not explicitly set
    // This implements the tier-based requirements system
    let requirements = item.requirements;
    if (!requirements && item.tier && TierDataProvider.isLoaded()) {
      const tierableItem: TierableItem = {
        id: item.id,
        type: item.type,
        tier: item.tier,
        equipSlot: equipSlot || undefined,
        attackType: attackType || undefined,
        tool: item.tool,
      };
      const derived = TierDataProvider.getRequirements(tierableItem);
      if (derived) {
        // Calculate level as max of all skill requirements
        const level = Math.max(
          1,
          ...Object.values(derived).filter(
            (v): v is number => typeof v === "number",
          ),
        );
        requirements = {
          level,
          skills: derived,
        };
      }
    }

    // Derive simple defense/attack from detailed bonuses for backward compatibility.
    // Armor items define per-style bonuses (defenseStab, defenseSlash, etc.) but the
    // existing DamageCalculator reads simple "defense". Use highest melee defence as the
    // simple value until per-style combat is wired up.
    const bonuses = item.bonuses as Record<string, number> | undefined;
    if (bonuses) {
      if (bonuses.defense === undefined) {
        const ds = bonuses.defenseStab ?? 0;
        const dl = bonuses.defenseSlash ?? 0;
        const dc = bonuses.defenseCrush ?? 0;
        if (ds !== 0 || dl !== 0 || dc !== 0) {
          bonuses.defense = Math.max(ds, dl, dc);
        }
      }
      if (bonuses.attack === undefined) {
        const as_ = bonuses.attackStab ?? 0;
        const al = bonuses.attackSlash ?? 0;
        const ac = bonuses.attackCrush ?? 0;
        if (as_ !== 0 || al !== 0 || ac !== 0) {
          bonuses.attack = Math.max(as_, al, ac);
        }
      }
    }

    // Apply defaults only for missing fields (use ?? to preserve falsy values like 0)
    const normalized: Item = {
      ...item,
      type: item.type,
      weaponType: safeWeaponType,
      equipSlot: equipSlot as EquipmentSlotName | null,
      attackType,
      // Inventory properties with defaults
      quantity: item.quantity ?? 1,
      stackable: item.stackable ?? false,
      maxStackSize: item.maxStackSize ?? 1,
      value: item.value ?? 0,
      weight: item.weight ?? 0.1,
      // Equipment properties with defaults
      equipable: item.equipable ?? !!equipSlot,
      // Item properties with defaults
      description: item.description || item.name || "Item",
      examine: item.examine || item.description || item.name || "Item",
      // Optional properties
      healAmount: item.healAmount,
      attackSpeed: item.attackSpeed,
      // Melee weapons default to standard range, others use manifest value
      attackRange:
        item.attackRange ??
        (attackType === AttackType.MELEE
          ? COMBAT_CONSTANTS.DEFAULTS.ITEM.ATTACK_RANGE
          : undefined),
      equippedModelPath: item.equippedModelPath,
      equippedModelSha256,
      equippedModelPathsByAvatar,
      equippedModelSha256ByAvatar,
      gatheringModelPathsByAvatar,
      gatheringModelSha256ByAvatar,
      bonuses: item.bonuses,
      requirements: requirements,
    };
    return normalized;
  }

  /**
   * Build EXTERNAL_TOOLS map from items where item.tool is defined
   * This replaces loading from tools.json
   */
  private buildToolsFromItems(): void {
    if (
      !(
        globalThis as {
          EXTERNAL_TOOLS?: Map<string, GatheringToolData>;
        }
      ).EXTERNAL_TOOLS
    ) {
      (
        globalThis as {
          EXTERNAL_TOOLS?: Map<string, GatheringToolData>;
        }
      ).EXTERNAL_TOOLS = new Map();
    }

    const toolsMap = (
      globalThis as unknown as {
        EXTERNAL_TOOLS: Map<string, GatheringToolData>;
      }
    ).EXTERNAL_TOOLS;

    // Clear existing tools
    toolsMap.clear();

    // Build tools from items
    for (const [itemId, item] of ITEMS) {
      if (item.tool) {
        // Determine level required from tier or explicit requirements
        let levelRequired = 1;
        if (item.requirements?.skills) {
          // Use the skill level from requirements that matches the tool skill
          const skillLevel = item.requirements.skills[item.tool.skill];
          if (skillLevel) {
            levelRequired = skillLevel;
          }
        } else if (item.tier && TierDataProvider.isLoaded()) {
          // Derive from tier
          const tierableItem: TierableItem = {
            id: item.id,
            type: item.type,
            tier: item.tier,
            tool: item.tool,
          };
          const derived = TierDataProvider.getRequirements(tierableItem);
          if (derived) {
            const skillLevel = derived[item.tool.skill as keyof typeof derived];
            if (skillLevel) {
              levelRequired = skillLevel;
            }
          }
        }

        const toolData: GatheringToolData = {
          itemId,
          skill: item.tool.skill,
          tier: item.tier || "unknown",
          levelRequired,
          rollTicks: item.tool.rollTicks,
          priority: item.tool.priority,
        };

        toolsMap.set(itemId, toolData);
      }
    }
  }

  /**
   * Load recipe manifests from CDN
   */
  private async loadRecipeManifestsFromCDN(baseUrl: string): Promise<void> {
    // Fire ALL recipe + supplementary manifest fetches in parallel
    await Promise.allSettled([
      // Cooking
      (async () => {
        try {
          const cookingRes = await fetch(`${baseUrl}/recipes/cooking.json`);
          const cookingManifest = (await cookingRes.json()) as CookingManifest;
          processingDataProvider.loadCookingRecipes(cookingManifest);
        } catch {
          console.warn(
            "[DataManager] recipes/cooking.json not found, falling back to embedded item data",
          );
        }
      })(),

      // Firemaking
      (async () => {
        try {
          const firemakingRes = await fetch(
            `${baseUrl}/recipes/firemaking.json`,
          );
          const firemakingManifest =
            (await firemakingRes.json()) as FiremakingManifest;
          processingDataProvider.loadFiremakingRecipes(firemakingManifest);
        } catch {
          console.warn(
            "[DataManager] recipes/firemaking.json not found, falling back to embedded item data",
          );
        }
      })(),

      // Smelting
      (async () => {
        try {
          const smeltingRes = await fetch(`${baseUrl}/recipes/smelting.json`);
          const smeltingManifest =
            (await smeltingRes.json()) as SmeltingManifest;
          processingDataProvider.loadSmeltingRecipes(smeltingManifest);
        } catch {
          console.warn(
            "[DataManager] recipes/smelting.json not found, falling back to embedded item data",
          );
        }
      })(),

      // Smithing
      (async () => {
        try {
          const smithingRes = await fetch(`${baseUrl}/recipes/smithing.json`);
          const smithingManifest =
            (await smithingRes.json()) as SmithingManifest;
          processingDataProvider.loadSmithingRecipes(smithingManifest);
        } catch {
          warnOptionalData(
            "[DataManager] recipes/smithing.json not found, falling back to embedded item data",
          );
        }
      })(),

      // Crafting
      (async () => {
        try {
          const craftingRes = await fetch(`${baseUrl}/recipes/crafting.json`);
          const craftingManifest =
            (await craftingRes.json()) as CraftingManifest;
          processingDataProvider.loadCraftingRecipes(craftingManifest);
        } catch {
          warnOptionalData(
            "[DataManager] recipes/crafting.json not found, crafting will be unavailable",
          );
        }
      })(),

      // Tanning
      (async () => {
        try {
          const tanningRes = await fetch(`${baseUrl}/recipes/tanning.json`);
          const tanningManifest = (await tanningRes.json()) as TanningManifest;
          processingDataProvider.loadTanningRecipes(tanningManifest);
        } catch {
          warnOptionalData(
            "[DataManager] recipes/tanning.json not found, tanning will be unavailable",
          );
        }
      })(),

      // Fletching
      (async () => {
        try {
          const fletchingRes = await fetch(`${baseUrl}/recipes/fletching.json`);
          const fletchingManifest =
            (await fletchingRes.json()) as FletchingManifest;
          processingDataProvider.loadFletchingRecipes(fletchingManifest);
        } catch {
          warnOptionalData(
            "[DataManager] recipes/fletching.json not found, fletching will be unavailable",
          );
        }
      })(),

      // Runecrafting
      (async () => {
        try {
          const runecraftingRes = await fetch(
            `${baseUrl}/recipes/runecrafting.json`,
          );
          const runecraftingManifest =
            (await runecraftingRes.json()) as RunecraftingManifest;
          processingDataProvider.loadRunecraftingRecipes(runecraftingManifest);
        } catch {
          warnOptionalData(
            "[DataManager] recipes/runecrafting.json not found, runecrafting will be unavailable",
          );
        }
      })(),

      // Prayers
      (async () => {
        try {
          const prayersRes = await fetch(`${baseUrl}/prayers.json`);
          if (!prayersRes.ok) {
            throw new Error(
              `HTTP ${prayersRes.status}: ${prayersRes.statusText}`,
            );
          }
          const prayersManifest = (await prayersRes.json()) as PrayersManifest;
          prayerDataProvider.loadPrayers(prayersManifest);
          prayerDataProvider.rebuild();
        } catch (err) {
          console.warn(
            `[DataManager] prayers.json not found (${err instanceof Error ? err.message : String(err)}), prayer system will be unavailable`,
          );
        }
      })(),

      // Model bounds → stations (sequential dependency: bounds must load before stations)
      (async () => {
        try {
          const boundsManifest = await fetchRequiredJson<ModelBoundsManifest>(
            `${baseUrl}/model-bounds.json`,
            "model-bounds.json",
          );
          stationDataProvider.loadModelBounds(boundsManifest);
          this.worldIdentityBuilder.record("model-bounds.json", boundsManifest);
        } catch {
          console.warn(
            "[DataManager] model-bounds.json not found, using default footprints",
          );
        }

        // Stations depends on model-bounds being loaded first
        try {
          const stationsManifest = await fetchRequiredJson<StationsManifest>(
            `${baseUrl}/stations.json`,
            "stations.json",
          );
          stationDataProvider.loadStations(stationsManifest);
          this.worldIdentityBuilder.record("stations.json", stationsManifest);
        } catch {
          console.warn(
            "[DataManager] stations.json not found, using default station data",
          );
        }
      })(),
    ]);

    // Rebuild ProcessingDataProvider to use the loaded manifests
    // This is necessary in case it was already lazy-initialized before manifests loaded
    processingDataProvider.rebuild();
  }

  /**
   * Load recipe manifests from filesystem (server-side)
   */
  private async loadRecipeManifestsFromFilesystem(
    fs: typeof import("fs/promises"),
    path: typeof import("path"),
    manifestsDir: string,
  ): Promise<void> {
    const recipesDir = path.join(manifestsDir, "recipes");

    // Load cooking recipes
    try {
      const cookingPath = path.join(recipesDir, "cooking.json");
      const cookingData = await fs.readFile(cookingPath, "utf-8");
      const cookingManifest = JSON.parse(cookingData) as CookingManifest;
      processingDataProvider.loadCookingRecipes(cookingManifest);
    } catch {
      console.warn(
        "[DataManager] recipes/cooking.json not found, falling back to embedded item data",
      );
    }

    // Load firemaking recipes
    try {
      const firemakingPath = path.join(recipesDir, "firemaking.json");
      const firemakingData = await fs.readFile(firemakingPath, "utf-8");
      const firemakingManifest = JSON.parse(
        firemakingData,
      ) as FiremakingManifest;
      processingDataProvider.loadFiremakingRecipes(firemakingManifest);
    } catch {
      console.warn(
        "[DataManager] recipes/firemaking.json not found, falling back to embedded item data",
      );
    }

    // Load smelting recipes
    try {
      const smeltingPath = path.join(recipesDir, "smelting.json");
      const smeltingData = await fs.readFile(smeltingPath, "utf-8");
      const smeltingManifest = JSON.parse(smeltingData) as SmeltingManifest;
      processingDataProvider.loadSmeltingRecipes(smeltingManifest);
    } catch {
      console.warn(
        "[DataManager] recipes/smelting.json not found, falling back to embedded item data",
      );
    }

    // Load smithing recipes
    try {
      const smithingPath = path.join(recipesDir, "smithing.json");
      const smithingData = await fs.readFile(smithingPath, "utf-8");
      const smithingManifest = JSON.parse(smithingData) as SmithingManifest;
      processingDataProvider.loadSmithingRecipes(smithingManifest);
    } catch {
      warnOptionalData(
        "[DataManager] recipes/smithing.json not found, falling back to embedded item data",
      );
    }

    // Load crafting recipes
    try {
      const craftingPath = path.join(recipesDir, "crafting.json");
      const craftingData = await fs.readFile(craftingPath, "utf-8");
      const craftingManifest = JSON.parse(craftingData) as CraftingManifest;
      processingDataProvider.loadCraftingRecipes(craftingManifest);
    } catch (e: unknown) {
      warnOptionalData(
        `[DataManager] recipes/crafting.json failed to load: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }

    // Load tanning recipes
    try {
      const tanningPath = path.join(recipesDir, "tanning.json");
      const tanningData = await fs.readFile(tanningPath, "utf-8");
      const tanningManifest = JSON.parse(tanningData) as TanningManifest;
      processingDataProvider.loadTanningRecipes(tanningManifest);
    } catch {
      warnOptionalData(
        "[DataManager] recipes/tanning.json not found, tanning will be unavailable",
      );
    }

    // Load fletching recipes
    try {
      const fletchingPath = path.join(recipesDir, "fletching.json");
      const fletchingData = await fs.readFile(fletchingPath, "utf-8");
      const fletchingManifest = JSON.parse(fletchingData) as FletchingManifest;
      processingDataProvider.loadFletchingRecipes(fletchingManifest);
    } catch {
      warnOptionalData(
        "[DataManager] recipes/fletching.json not found, fletching will be unavailable",
      );
    }

    // Load runecrafting recipes
    try {
      const runecraftingPath = path.join(recipesDir, "runecrafting.json");
      const runecraftingData = await fs.readFile(runecraftingPath, "utf-8");
      const runecraftingManifest = JSON.parse(
        runecraftingData,
      ) as RunecraftingManifest;
      processingDataProvider.loadRunecraftingRecipes(runecraftingManifest);
    } catch {
      warnOptionalData(
        "[DataManager] recipes/runecrafting.json not found, runecrafting will be unavailable",
      );
    }

    // Load prayer manifest
    try {
      const prayersPath = path.join(manifestsDir, "prayers.json");
      const prayersData = await fs.readFile(prayersPath, "utf-8");
      const prayersManifest = JSON.parse(prayersData) as PrayersManifest;
      prayerDataProvider.loadPrayers(prayersManifest);
      prayerDataProvider.rebuild();
    } catch (err) {
      console.warn(
        `[DataManager] prayers.json not found (${err instanceof Error ? err.message : String(err)}), prayer system will be unavailable`,
      );
    }

    // Rebuild ProcessingDataProvider to use the loaded manifests
    // This is necessary in case it was already lazy-initialized before manifests loaded
    processingDataProvider.rebuild();

    // Load model bounds manifest (for automatic footprint calculation)
    // Must load BEFORE stations.json so footprints can be auto-calculated
    try {
      const boundsPath = path.join(manifestsDir, "model-bounds.json");
      const boundsData = await fs.readFile(boundsPath, "utf-8");
      const boundsManifest = JSON.parse(boundsData) as ModelBoundsManifest;
      stationDataProvider.loadModelBounds(boundsManifest);
      this.worldIdentityBuilder.record("model-bounds.json", boundsManifest);
    } catch {
      console.warn(
        "[DataManager] model-bounds.json not found, using default footprints",
      );
    }

    // Load stations manifest
    try {
      const stationsPath = path.join(manifestsDir, "stations.json");
      const stationsData = await fs.readFile(stationsPath, "utf-8");
      const stationsManifest = JSON.parse(stationsData) as StationsManifest;
      stationDataProvider.loadStations(stationsManifest);
      this.worldIdentityBuilder.record("stations.json", stationsManifest);
    } catch {
      console.warn(
        "[DataManager] stations.json not found, using default station data",
      );
    }
  }

  /**
   * Load gathering manifests from CDN
   * Loads woodcutting, mining, and fishing data from gathering/*.json
   * and populates EXTERNAL_RESOURCES for ResourceSystem
   */
  private async loadGatheringManifestsFromCDN(baseUrl: string): Promise<void> {
    // Initialize EXTERNAL_RESOURCES map if needed
    if (
      !(
        globalThis as {
          EXTERNAL_RESOURCES?: Map<string, ExternalResourceData>;
        }
      ).EXTERNAL_RESOURCES
    ) {
      (
        globalThis as {
          EXTERNAL_RESOURCES?: Map<string, ExternalResourceData>;
        }
      ).EXTERNAL_RESOURCES = new Map();
    }

    const resourcesMap = (
      globalThis as unknown as {
        EXTERNAL_RESOURCES: Map<string, ExternalResourceData>;
      }
    ).EXTERNAL_RESOURCES;

    // Load all 3 gathering manifests in parallel
    await Promise.allSettled([
      // Woodcutting (trees)
      (async () => {
        try {
          const woodcuttingManifest =
            await fetchRequiredJson<WoodcuttingManifest>(
              `${baseUrl}/gathering/woodcutting.json`,
              "gathering/woodcutting.json",
            );
          for (const tree of woodcuttingManifest.trees) {
            resourcesMap.set(tree.id, tree);
          }
          this.worldIdentityBuilder.record(
            "gathering/woodcutting.json",
            woodcuttingManifest,
          );
        } catch {
          console.warn(
            "[DataManager] gathering/woodcutting.json not found, trying legacy resources.json",
          );
        }
      })(),

      // Mining (rocks/ores)
      (async () => {
        try {
          const miningManifest = await fetchRequiredJson<MiningManifest>(
            `${baseUrl}/gathering/mining.json`,
            "gathering/mining.json",
          );
          for (const rock of miningManifest.rocks) {
            resourcesMap.set(rock.id, rock);
          }
          this.worldIdentityBuilder.record(
            "gathering/mining.json",
            miningManifest,
          );
        } catch {
          console.warn(
            "[DataManager] gathering/mining.json not found, trying legacy resources.json",
          );
        }
      })(),

      // Fishing (spots)
      (async () => {
        try {
          const fishingManifest = await fetchRequiredJson<FishingManifest>(
            `${baseUrl}/gathering/fishing.json`,
            "gathering/fishing.json",
          );
          for (const spot of fishingManifest.spots) {
            resourcesMap.set(spot.id, spot);
          }
          this.worldIdentityBuilder.record(
            "gathering/fishing.json",
            fishingManifest,
          );
        } catch {
          console.warn(
            "[DataManager] gathering/fishing.json not found, trying legacy resources.json",
          );
        }
      })(),
    ]);

    // Fallback to legacy resources.json if no resources loaded
    if (resourcesMap.size === 0) {
      console.warn(
        "[DataManager] No gathering manifests found, falling back to resources.json",
      );
      try {
        // Legacy fallback - resources.json is in items/ folder
        const resourcesRes = await fetch(`${baseUrl}/items/resources.json`);
        const resourceList =
          (await resourcesRes.json()) as Array<ExternalResourceData>;
        for (const resource of resourceList) {
          resourcesMap.set(resource.id, resource);
        }
      } catch {
        console.error(
          "[DataManager] Failed to load resources - gathering skills will not work",
        );
      }
    }
  }

  /**
   * Load gathering manifests from filesystem (server-side)
   * Loads woodcutting, mining, and fishing data from gathering/*.json
   * and populates EXTERNAL_RESOURCES for ResourceSystem
   */
  private async loadGatheringManifestsFromFilesystem(
    fs: typeof import("fs/promises"),
    path: typeof import("path"),
    manifestsDir: string,
  ): Promise<void> {
    // Initialize EXTERNAL_RESOURCES map if needed
    if (
      !(
        globalThis as {
          EXTERNAL_RESOURCES?: Map<string, ExternalResourceData>;
        }
      ).EXTERNAL_RESOURCES
    ) {
      (
        globalThis as {
          EXTERNAL_RESOURCES?: Map<string, ExternalResourceData>;
        }
      ).EXTERNAL_RESOURCES = new Map();
    }

    const resourcesMap = (
      globalThis as unknown as {
        EXTERNAL_RESOURCES: Map<string, ExternalResourceData>;
      }
    ).EXTERNAL_RESOURCES;

    const gatheringDir = path.join(manifestsDir, "gathering");

    // Local manifests directory (in main codebase, takes priority over git repo)
    const localManifestsDir = path.join(
      manifestsDir,
      "..",
      "..",
      "..",
      "manifests",
      "gathering",
    );

    // Load woodcutting (trees) — check local manifest first, then fall back to git repo
    try {
      let woodcuttingData: string | null = null;
      let source = "";

      // Try local manifest first (packages/server/manifests/gathering/woodcutting.json)
      try {
        const localPath = path.join(localManifestsDir, "woodcutting.json");
        woodcuttingData = await fs.readFile(localPath, "utf-8");
        source = localPath;
      } catch {
        // Local not found, fall back to git repo manifest
        const repoPath = path.join(gatheringDir, "woodcutting.json");
        woodcuttingData = await fs.readFile(repoPath, "utf-8");
        source = repoPath;
      }

      const woodcuttingManifest = JSON.parse(
        woodcuttingData,
      ) as WoodcuttingManifest;
      for (const tree of woodcuttingManifest.trees) {
        resourcesMap.set(tree.id, tree);
      }
      this.worldIdentityBuilder.record(
        "gathering/woodcutting.json",
        woodcuttingManifest,
      );
      console.log(
        `[DataManager] ✅ Loaded woodcutting manifest (${woodcuttingManifest.trees.length} trees) from: ${source}`,
      );
    } catch {
      console.warn(
        "[DataManager] gathering/woodcutting.json not found, trying legacy resources.json",
      );
    }

    // Load mining (rocks/ores)
    try {
      const miningPath = path.join(gatheringDir, "mining.json");
      const miningData = await fs.readFile(miningPath, "utf-8");
      const miningManifest = JSON.parse(miningData) as MiningManifest;
      for (const rock of miningManifest.rocks) {
        resourcesMap.set(rock.id, rock);
      }
      this.worldIdentityBuilder.record("gathering/mining.json", miningManifest);
    } catch {
      console.warn(
        "[DataManager] gathering/mining.json not found, trying legacy resources.json",
      );
    }

    // Load fishing (spots)
    try {
      const fishingPath = path.join(gatheringDir, "fishing.json");
      const fishingData = await fs.readFile(fishingPath, "utf-8");
      const fishingManifest = JSON.parse(fishingData) as FishingManifest;
      for (const spot of fishingManifest.spots) {
        resourcesMap.set(spot.id, spot);
      }
      this.worldIdentityBuilder.record(
        "gathering/fishing.json",
        fishingManifest,
      );
    } catch {
      console.warn(
        "[DataManager] gathering/fishing.json not found, trying legacy resources.json",
      );
    }

    // Fallback to legacy resources.json if no resources loaded
    if (resourcesMap.size === 0) {
      console.warn(
        "[DataManager] No gathering manifests found, falling back to resources.json",
      );
      try {
        const resourcesPath = path.join(manifestsDir, "resources.json");
        const resourcesData = await fs.readFile(resourcesPath, "utf-8");
        const resourceList = JSON.parse(
          resourcesData,
        ) as Array<ExternalResourceData>;
        for (const resource of resourceList) {
          resourcesMap.set(resource.id, resource);
        }
      } catch {
        console.error(
          "[DataManager] Failed to load resources - gathering skills will not work",
        );
      }
    }
  }

  private normalizeNPC(npc: NPCDataInput): NPCData {
    // Ensure required fields have sane defaults
    const archetypeModel = npc.modelArchetype
      ? NPC_MODEL_ARCHETYPES[npc.modelArchetype]
      : undefined;
    const fallbackModel =
      npc.category === "neutral" || npc.category === "quest"
        ? NPC_MODEL_ARCHETYPES.human
        : NPC_MODEL_ARCHETYPES.goblin;

    // NOTE: VRM files are preferred for rigged characters because:
    // 1. VRM factory auto-normalizes to 1.6m height
    // 2. VRM handles skeleton binding correctly
    // 3. GLB rigged models break when scaled (skeleton/animation issues)
    // If VRM has buffer parsing issues, fix the VRM file (optimize/compress) rather than substituting GLB
    // Handle levelRange - can be array [min, max] or object { min, max } in JSON
    let levelRange: LevelRange | undefined;
    if (npc.levelRange) {
      if (Array.isArray(npc.levelRange)) {
        // Convert array format [min, max] to object format
        const [min, max] = npc.levelRange as unknown as [number, number];
        levelRange = { min, max };
      } else {
        levelRange = npc.levelRange;
      }
    }

    const defaults: Partial<NPCData> = {
      faction: npc.faction || "unknown",
      spawnCategory:
        npc.spawnCategory ?? (npc.category === "boss" ? "world" : undefined),
      modelArchetype: npc.modelArchetype,
      levelRange,
      stats: {
        level: npc.stats?.level ?? 1,
        health: npc.stats?.health ?? 10, // classic MMORPG: hitpoints = max HP directly
        attack: npc.stats?.attack ?? 1,
        strength: npc.stats?.strength ?? 1,
        defense: npc.stats?.defense ?? 1,
        defenseBonus: npc.stats?.defenseBonus ?? 0,
        ranged: npc.stats?.ranged ?? 1,
        magic: npc.stats?.magic ?? 1,
      },
      combat: {
        attackable: npc.combat?.attackable ?? true,
        aggressive: npc.combat?.aggressive ?? false,
        retaliates: npc.combat?.retaliates ?? true,
        aggroRange: npc.combat?.aggroRange ?? 0, // 0 = non-aggressive by default
        combatRange:
          npc.combat?.combatRange ?? COMBAT_CONSTANTS.DEFAULTS.NPC.COMBAT_RANGE,
        leashRange:
          npc.combat?.leashRange ?? COMBAT_CONSTANTS.DEFAULTS.NPC.LEASH_RANGE,
        attackSpeedTicks:
          npc.combat?.attackSpeedTicks ??
          COMBAT_CONSTANTS.DEFAULTS.NPC.ATTACK_SPEED_TICKS,
        respawnTime:
          (npc.combat?.respawnTicks ??
            COMBAT_CONSTANTS.DEFAULTS.NPC.RESPAWN_TICKS) *
          COMBAT_CONSTANTS.TICK_DURATION_MS, // Convert ticks to ms
        xpReward: npc.combat?.xpReward ?? 0,
        poisonous: npc.combat?.poisonous ?? false,
        immuneToPoison: npc.combat?.immuneToPoison ?? false,
        attackType: npc.combat?.attackType ?? "melee",
        spellId: npc.combat?.spellId,
        arrowId: npc.combat?.arrowId,
      },
      movement: {
        type: npc.movement?.type ?? "stationary",
        speed: npc.movement?.speed ?? 1,
        wanderRadius: npc.movement?.wanderRadius ?? 0,
        roaming: npc.movement?.roaming ?? false,
      },
      drops: {
        defaultDrop: npc.drops?.defaultDrop ?? {
          enabled: false,
          itemId: "",
          quantity: 0,
        },
        always: npc.drops?.always ?? [],
        common: npc.drops?.common ?? [],
        uncommon: npc.drops?.uncommon ?? [],
        rare: npc.drops?.rare ?? [],
        veryRare: npc.drops?.veryRare ?? [],
        rareDropTable: npc.drops?.rareDropTable ?? false,
        rareDropTableChance: npc.drops?.rareDropTableChance,
      },
      services: {
        enabled: npc.services?.enabled ?? false,
        types: npc.services?.types ?? [],
        shopInventory: npc.services?.shopInventory,
        questIds: npc.services?.questIds,
      },
      behavior: {
        enabled: npc.behavior?.enabled ?? false,
        config: npc.behavior?.config,
      },
      appearance: {
        modelPath: npc.appearance?.modelPath ?? archetypeModel ?? fallbackModel,
        iconPath: npc.appearance?.iconPath,
        scale: npc.appearance?.scale ?? 1.0,
        tint: npc.appearance?.tint,
        heldWeaponModel: npc.appearance?.heldWeaponModel,
      },
      position: npc.position || { x: 0, y: 0, z: 0 },
    };
    return {
      ...npc,
      ...defaults,
    } as NPCData;
  }

  /**
   * Initialize the data manager and validate all data
   */
  public initialize(): Promise<DataValidationResult> {
    if (this.isInitialized) {
      return Promise.resolve(this.validationResult!);
    }
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  /** Only called before readiness or after a failed attempt, never for hot reload. */
  private clearInitializationContent(): void {
    this.isInitialized = false;
    this.validationResult = null;
    this.worldAssetsDir = null;
    this.worldIdentityBuilder = new WorldManifestIdentityBuilder();
    DataManager.worldContentIdentity = null;
    DataManager.worldTerrainProfile = null;
    DataManager.worldConfig = null;
    DataManager.buildingsManifest = null;
    (ITEMS as Map<string, Item>).clear();
    (ALL_NPCS as Map<string, NPCData>).clear();
    for (const entries of [
      ALL_WORLD_AREAS,
      STARTER_TOWNS,
      BIOMES,
      GENERAL_STORES,
    ])
      for (const key of Object.keys(entries)) delete entries[key];
    const external = globalThis as {
      EXTERNAL_RESOURCES?: Map<string, ExternalResourceData>;
      EXTERNAL_TOOLS?: Map<string, GatheringToolData>;
    };
    external.EXTERNAL_RESOURCES?.clear();
    external.EXTERNAL_TOOLS?.clear();
    TierDataProvider.reset();
    stationDataProvider.loadStations({ stations: [] });
    stationDataProvider.loadModelBounds({
      generatedAt: "",
      tileSize: 100,
      models: [],
    });
  }

  private async initializeOnce(): Promise<DataValidationResult> {
    this.clearInitializationContent();
    try {
      // Load externally generated assets (Forge) before validation
      await this.loadExternalAssetsFromWorld();

      this.validationResult = await this.validateAllData();

      const skipValidation =
        typeof process !== "undefined" &&
        typeof process.env !== "undefined" &&
        process.env.SKIP_VALIDATION === "true";

      if (!this.validationResult.isValid && !skipValidation) {
        throw new Error(
          `[DataManager] ❌ Data validation failed: ${this.validationResult.errors.join(", ")}`,
        );
      }

      // This mandatory identity gate cannot be bypassed by SKIP_VALIDATION or
      // optional-manifest fallbacks. Complete it before any readiness is exposed.
      DataManager.worldContentIdentity = await this.worldIdentityBuilder.build(
        DataManager.getWorldTerrainProfile(),
      );
      this.isInitialized = true;

      return this.validationResult;
    } catch (error) {
      this.clearInitializationContent();
      throw error;
    }
  }

  /**
   * Validate all externalized data
   */
  private async validateAllData(): Promise<DataValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if we're in a TEST environment where manifests might not exist
    // NOTE: CI=true is often set by CI/CD platforms AND production deployments (Railway)
    // Only skip validation for actual test environments, not production CI/CD
    const isTestEnv =
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      (process.env.NODE_ENV === "test" || process.env.VITEST === "true");

    // Validate items (warning only - manifests might be loading)
    const itemCount = ITEMS.size;
    if (itemCount === 0) {
      warnings.push("No items loaded from manifests yet");
    }

    // Validate NPCs (warning only - manifests might be loading)
    const npcCount = ALL_NPCS.size;
    if (npcCount === 0) {
      warnings.push("No NPCs loaded from manifests yet");
    }

    // Validate world areas (warning in test/CI, error in production)
    const areaCount = Object.keys(ALL_WORLD_AREAS).length;
    if (areaCount === 0) {
      if (isTestEnv) {
        warnings.push(
          "No world areas found - expected in CI/test without manifests",
        );
      } else {
        errors.push("No world areas found in ALL_WORLD_AREAS");
      }
    }

    const externalValueEnabled = isExternalValueEnabled();
    const requireApprovedDeathCustody =
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      (externalValueEnabled ||
        process.env.HYPERIA_REQUIRE_APPROVED_PREPARATION_DEATH_CUSTODY ===
          "true");
    errors.push(
      ...validatePreparationDeathCustodyAreas(ALL_WORLD_AREAS, {
        requireApproval: requireApprovedDeathCustody,
      }),
    );
    errors.push(
      ...validateExternalValueWorldAreaSafety(ALL_WORLD_AREAS, {
        externalValueEnabled,
      }),
    );

    // Validate treasure locations
    const treasureCount = Object.keys(TREASURE_LOCATIONS).length;
    if (treasureCount === 0) {
      warnings.push("No treasure locations found in TREASURE_LOCATIONS");
    }

    // Validate equipSlot values match valid EquipmentSlotName or "2h"
    if (itemCount > 0) {
      const validSlots = new Set<string>([
        ...Object.values(EquipmentSlotName),
        "2h",
      ]);
      for (const [itemId, item] of ITEMS) {
        if (item.equipSlot && !validSlots.has(item.equipSlot)) {
          errors.push(
            `Item "${itemId}" has invalid equipSlot "${item.equipSlot}" (valid: ${[...validSlots].join(", ")})`,
          );
        }
      }
    }

    // Validate cross-references (only if we have data)
    if (itemCount > 0 && npcCount > 0) {
      this.validateCrossReferences(errors, warnings);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      itemCount,
      npcCount,
      areaCount,
      treasureCount,
    };
  }

  /**
   * Validate cross-references between data sets
   */
  private validateCrossReferences(errors: string[], _warnings: string[]): void {
    // Check that mob spawn points reference valid mobs
    for (const [areaId, area] of Object.entries(ALL_WORLD_AREAS)) {
      if (area.mobSpawns) {
        for (const mobSpawn of area.mobSpawns) {
          if (!ALL_NPCS.has(mobSpawn.mobId)) {
            errors.push(
              `Area ${areaId} references unknown NPC: ${mobSpawn.mobId}`,
            );
          }
        }
      }
    }

    // Validate NPC level ranges
    for (const npc of ALL_NPCS.values()) {
      const range = npc.levelRange;
      if (range) {
        const min = range.min;
        const max = range.max;
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          errors.push(`NPC ${npc.id} has non-finite levelRange values`);
          continue;
        }
        if (min < 1) {
          errors.push(`NPC ${npc.id} levelRange.min must be >= 1`);
        }
        if (max < min) {
          errors.push(`NPC ${npc.id} levelRange.max must be >= min`);
        }
        if (max > 1000) {
          errors.push(`NPC ${npc.id} levelRange.max must be <= 1000`);
        }
        if (npc.stats.level < min || npc.stats.level > max) {
          errors.push(
            `NPC ${npc.id} stats.level must be within levelRange (${min}-${max})`,
          );
        }
      } else if (npc.category === "mob" || npc.category === "boss") {
        errors.push(`NPC ${npc.id} is missing levelRange`);
      }
    }

    // Validate biome mob definitions
    for (const biome of Object.values(BIOMES)) {
      const mobTypes = biome.mobTypes || [];
      const mobs = biome.mobs || [];
      const mobTypeSet = new Set(mobTypes);
      const mobsSet = new Set(mobs);

      if (mobTypes.length !== mobs.length) {
        errors.push(`Biome ${biome.id} has mismatched mobs vs mobTypes length`);
      }

      for (const mobId of mobTypes) {
        if (!mobsSet.has(mobId)) {
          errors.push(
            `Biome ${biome.id} mobTypes includes ${mobId} missing from mobs`,
          );
        }
        if (!ALL_NPCS.has(mobId)) {
          errors.push(
            `Biome ${biome.id} mobTypes references unknown NPC: ${mobId}`,
          );
        }
      }

      for (const mobId of mobs) {
        if (!mobTypeSet.has(mobId)) {
          errors.push(
            `Biome ${biome.id} mobs includes ${mobId} missing from mobTypes`,
          );
        }
      }
    }

    // Check that starter items reference valid items
    for (const startingItem of STARTING_ITEMS) {
      if (!ITEMS.has(startingItem.id)) {
        errors.push(
          `Starting item references unknown item: ${startingItem.id}`,
        );
      }
    }
  }

  /**
   * Get validation result
   */
  public getValidationResult(): DataValidationResult | null {
    return this.validationResult;
  }

  // =============================================================================
  // ITEM DATA ACCESS METHODS
  // =============================================================================

  /**
   * Get all items
   */
  public getAllItems(): Map<string, Item> {
    return ITEMS;
  }

  /**
   * Get item by ID
   */
  public getItem(itemId: string): Item | null {
    return ITEMS.get(itemId) || null;
  }

  /**
   * Get items by type
   */
  public getItemsByType(itemType: string): Item[] {
    return Array.from(ITEMS.values()).filter((item) => item.type === itemType);
  }

  // =============================================================================
  // NPC DATA ACCESS METHODS
  // =============================================================================

  /**
   * Get all NPCs
   */
  public getAllNPCs(): Map<string, NPCData> {
    return ALL_NPCS;
  }

  /**
   * Get NPC by ID
   */
  public getNPC(npcId: string): NPCData | null {
    return ALL_NPCS.get(npcId) || null;
  }

  /**
   * Get NPCs by category
   */
  public getNPCsByCategory(category: NPCCategory): NPCData[] {
    return Array.from(ALL_NPCS.values()).filter(
      (npc) => npc.category === category,
    );
  }

  // =============================================================================
  // WORLD AREA DATA ACCESS METHODS
  // =============================================================================

  /**
   * Get all world areas
   */
  public getAllWorldAreas(): Record<string, WorldArea> {
    return ALL_WORLD_AREAS;
  }

  /**
   * Get starter towns
   */
  public getStarterTowns(): Record<string, WorldArea> {
    return STARTER_TOWNS;
  }

  /**
   * Get world area by ID
   */
  public getWorldArea(areaId: string): WorldArea | null {
    return ALL_WORLD_AREAS[areaId] || null;
  }

  /**
   * Get mob spawns in area
   */
  public getMobSpawnsInArea(areaId: string): MobSpawnPoint[] {
    return getMobSpawnsInArea(areaId);
  }

  /**
   * Get NPCs in area
   */
  public getNPCsInArea(areaId: string): NPCLocation[] {
    return getNPCsInArea(areaId);
  }

  // =============================================================================
  // TREASURE DATA ACCESS METHODS
  // =============================================================================

  /**
   * Get all treasure locations
   */
  public getAllTreasureLocations(): TreasureLocation[] {
    return getAllTreasureLocations();
  }

  /**
   * Get treasure locations by difficulty
   */
  public getTreasureLocationsByDifficulty(
    difficulty: 1 | 2 | 3,
  ): TreasureLocation[] {
    return getTreasureLocationsByDifficulty(difficulty);
  }

  /**
   * Get treasure location by ID
   */
  public getTreasureLocation(locationId: string): TreasureLocation | null {
    return (
      TREASURE_LOCATIONS.find(
        (loc) => (loc as TreasureLocation & { id?: string }).id === locationId,
      ) || null
    );
  }

  // =============================================================================
  // STORE AND BANK DATA ACCESS METHODS
  // =============================================================================

  /**
   * Get all general stores
   */
  public getGeneralStores() {
    return GENERAL_STORES;
  }

  /**
   * Get all banks
   */
  public getBanks() {
    return BANKS;
  }

  // =============================================================================
  // STARTING DATA ACCESS METHODS
  // =============================================================================

  /**
   * Get starting items
   */
  public getStartingItems() {
    return STARTING_ITEMS;
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Check if data manager is initialized
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get data summary for debugging
   */
  public getDataSummary() {
    if (!this.isInitialized) {
      return "DataManager not initialized";
    }

    return {
      items: ITEMS.size,
      npcs: ALL_NPCS.size,
      worldAreas: Object.keys(ALL_WORLD_AREAS).length,
      treasureLocations: TREASURE_LOCATIONS.length,
      stores: Object.keys(GENERAL_STORES).length,
      banks: Object.keys(BANKS).length,
      startingItems: STARTING_ITEMS.length,
      isValid: this.validationResult?.isValid || false,
    };
  }
}

// Export singleton instance
export const dataManager = DataManager.getInstance();
