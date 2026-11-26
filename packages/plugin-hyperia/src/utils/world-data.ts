/**
 * World Data — static manifest data loader for deterministic decisions.
 *
 * Lazily loads and caches manifest JSON from the server package.
 * Used by the planner and behavior manager for code-level decisions
 * (NOT for LLM prompts).
 *
 * All reads are wrapped in try/catch — returns empty/defaults on failure
 * so the planner degrades gracefully.
 */

import fs from "fs";
import path from "path";
import { logger } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResourceEntry {
  id: string;
  name: string;
  levelRequired: number;
}

interface FoodEntry {
  id: string;
  name: string;
  healAmount: number;
}

export interface MonsterTier {
  id: string;
  name: string;
  level: number;
  location: string;
}

export interface GearTier {
  tierName: string;
  levelRequired: number;
  smithingLevel: number;
}

export interface PrayerEntry {
  id: string;
  name: string;
  level: number;
  category: string;
  bonuses: {
    attackMultiplier?: number;
    strengthMultiplier?: number;
    defenseMultiplier?: number;
    rangedAttackMultiplier?: number;
    rangedStrengthMultiplier?: number;
    magicAttackMultiplier?: number;
    magicDefenseMultiplier?: number;
  };
}

export interface RuneEntry {
  id: string;
  name: string;
  element: string | null;
}

export interface ToolEntry {
  itemId: string;
  skill: string;
  tier: string;
  levelRequired: number;
}

export interface ItemEntry {
  id: string;
  name: string;
  type: string;
  equipSlot: string | null;
  attackType: string | null;
  healAmount: number;
  tool: { skill: string; priority: number } | null;
}

interface ManifestCache {
  woodcutting: ResourceEntry[] | null;
  mining: ResourceEntry[] | null;
  fishing: ResourceEntry[] | null;
  food: FoodEntry[] | null;
  bankPosition: [number, number, number] | null;
  monsters: MonsterTier[] | null;
  prayers: PrayerEntry[] | null;
  runes: RuneEntry[] | null;
  tools: ToolEntry[] | null;
  items: ItemEntry[] | null;
  loaded: boolean;
}

// ---------------------------------------------------------------------------
// Module-level cache (parsed once)
// ---------------------------------------------------------------------------

const cache: ManifestCache = {
  woodcutting: null,
  mining: null,
  fishing: null,
  food: null,
  bankPosition: null,
  monsters: null,
  prayers: null,
  runes: null,
  tools: null,
  items: null,
  loaded: false,
};

/**
 * Resolve the base manifests directory.
 * Tries multiple paths to handle different runtime contexts.
 */
function resolveManifestsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "packages/server/world/assets/manifests"),
    path.resolve(process.cwd(), "../server/world/assets/manifests"),
    path.resolve(
      import.meta.dirname ?? process.cwd(),
      "../../../server/world/assets/manifests",
    ),
  ];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // ignore
    }
  }
  return null;
}

function readJSON(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lazy init — parse all manifests once on first access.
 */
function ensureLoaded(): void {
  if (cache.loaded) return;
  cache.loaded = true;

  const dir = resolveManifestsDir();
  if (!dir) {
    logger.warn(
      "[WorldData] Could not find manifests directory — using defaults",
    );
    return;
  }

  try {
    // Woodcutting
    const wc = readJSON(path.join(dir, "gathering/woodcutting.json")) as {
      trees?: Array<{ id: string; name: string; levelRequired: number }>;
    } | null;
    if (wc?.trees) {
      cache.woodcutting = wc.trees.map((t) => ({
        id: t.id,
        name: t.name,
        levelRequired: t.levelRequired ?? 1,
      }));
    }

    // Mining
    const mn = readJSON(path.join(dir, "gathering/mining.json")) as {
      rocks?: Array<{ id: string; name: string; levelRequired: number }>;
    } | null;
    if (mn?.rocks) {
      cache.mining = mn.rocks.map((r) => ({
        id: r.id,
        name: r.name,
        levelRequired: r.levelRequired ?? 1,
      }));
    }

    // Fishing — spots have levelRequired at top level + per-yield
    const fs_ = readJSON(path.join(dir, "gathering/fishing.json")) as {
      spots?: Array<{ id: string; name: string; levelRequired: number }>;
    } | null;
    if (fs_?.spots) {
      cache.fishing = fs_.spots.map((s) => ({
        id: s.id,
        name: s.name,
        levelRequired: s.levelRequired ?? 1,
      }));
    }

    // Food
    const fd = readJSON(path.join(dir, "items/food.json"));
    if (Array.isArray(fd)) {
      cache.food = (
        fd as Array<{ id: string; name: string; healAmount: number }>
      ).map((f) => ({
        id: f.id,
        name: f.name,
        healAmount: f.healAmount ?? 1,
      }));
    }

    const itemFiles = [
      "ammunition.json",
      "armor.json",
      "food.json",
      "misc.json",
      "resources.json",
      "runes.json",
      "tools.json",
      "weapons.json",
    ];
    const items: ItemEntry[] = [];
    const itemIds = new Set<string>();
    for (const filename of itemFiles) {
      const authored = readJSON(path.join(dir, "items", filename));
      if (!Array.isArray(authored)) continue;
      for (const raw of authored as Array<Record<string, unknown>>) {
        const id = typeof raw.id === "string" ? raw.id : "";
        const name = typeof raw.name === "string" ? raw.name : "";
        const type = typeof raw.type === "string" ? raw.type : "";
        if (!id || !name || !type || itemIds.has(id)) continue;
        const toolRaw =
          raw.tool && typeof raw.tool === "object" && !Array.isArray(raw.tool)
            ? (raw.tool as Record<string, unknown>)
            : null;
        const toolSkill =
          typeof toolRaw?.skill === "string" ? toolRaw.skill : "";
        const toolPriority = Number(toolRaw?.priority);
        itemIds.add(id);
        items.push({
          id,
          name,
          type,
          equipSlot: typeof raw.equipSlot === "string" ? raw.equipSlot : null,
          attackType:
            typeof raw.attackType === "string" ? raw.attackType : null,
          healAmount:
            Number.isFinite(Number(raw.healAmount)) &&
            Number(raw.healAmount) > 0
              ? Number(raw.healAmount)
              : 0,
          tool:
            toolSkill && Number.isFinite(toolPriority)
              ? { skill: toolSkill, priority: toolPriority }
              : null,
        });
      }
    }
    cache.items = items;

    // World areas — used for bank position + mob spawn locations
    interface WorldArea {
      npcs?: Array<{
        type: string;
        position: { x: number; y: number; z: number };
      }>;
      mobSpawns?: Array<{ mobId: string }>;
    }
    const wa = readJSON(path.join(dir, "world-areas.json")) as Record<
      string,
      Record<string, WorldArea>
    > | null;

    // Bank position — first bank NPC in starter town
    if (wa?.starterTowns) {
      for (const town of Object.values(wa.starterTowns)) {
        const bankNpc = town.npcs?.find((n) => n.type === "bank");
        if (bankNpc?.position) {
          cache.bankPosition = [
            bankNpc.position.x,
            bankNpc.position.y,
            bankNpc.position.z,
          ];
          break;
        }
      }
    }

    // Monster tiers — load from npcs.json + map locations from world-areas.json
    const npcs = readJSON(path.join(dir, "npcs.json")) as Array<{
      id: string;
      name: string;
      category?: string;
      stats?: { level?: number };
    }> | null;

    if (npcs) {
      // Build mob→location mapping from world-areas.json mob spawns
      const mobLocationMap = new Map<string, string>();
      if (wa) {
        // Known area-key → planner location mappings
        const areaLocationMap: Record<string, string> = {
          central_haven: "spawn",
        };
        for (const areaGroup of Object.values(wa)) {
          if (typeof areaGroup !== "object" || areaGroup === null) continue;
          for (const [areaKey, area] of Object.entries(areaGroup)) {
            if (!area?.mobSpawns) continue;
            const location = areaLocationMap[areaKey] || areaKey;
            for (const spawn of area.mobSpawns) {
              // First area wins (most accessible location for that mob)
              if (!mobLocationMap.has(spawn.mobId)) {
                mobLocationMap.set(spawn.mobId, location);
              }
            }
          }
        }
      }

      cache.monsters = npcs
        .filter((n) => n.category === "mob")
        .map((n) => ({
          id: n.id,
          name: n.name,
          level: n.stats?.level ?? 1,
          location: mobLocationMap.get(n.id) || "spawn",
        }))
        .sort((a, b) => a.level - b.level);
    }

    // Prayers
    const pr = readJSON(path.join(dir, "prayers.json")) as {
      prayers?: Array<{
        id: string;
        name: string;
        level: number;
        category: string;
        bonuses?: PrayerEntry["bonuses"];
      }>;
    } | null;
    if (pr?.prayers) {
      cache.prayers = pr.prayers.map((p) => ({
        id: p.id,
        name: p.name,
        level: p.level ?? 1,
        category: p.category ?? "offensive",
        bonuses: p.bonuses ?? {},
      }));
    }

    // Runes
    const rn = readJSON(path.join(dir, "runes.json")) as {
      runes?: Array<{ id: string; name: string; element: string | null }>;
    } | null;
    if (rn?.runes) {
      cache.runes = rn.runes.map((r) => ({
        id: r.id,
        name: r.name,
        element: r.element ?? null,
      }));
    }

    // Tools (root is array)
    const tl = readJSON(path.join(dir, "tools.json"));
    if (Array.isArray(tl)) {
      cache.tools = (
        tl as Array<{
          itemId: string;
          skill: string;
          tier: string;
          levelRequired: number;
        }>
      ).map((t) => ({
        itemId: t.itemId,
        skill: t.skill,
        tier: t.tier ?? "standard",
        levelRequired: t.levelRequired ?? 1,
      }));
    }

    logger.info(
      `[WorldData] Loaded manifests: ${cache.woodcutting?.length ?? 0} trees, ${cache.mining?.length ?? 0} rocks, ${cache.fishing?.length ?? 0} fishing spots, ${cache.food?.length ?? 0} food items, ${cache.monsters?.length ?? 0} monsters, ${cache.prayers?.length ?? 0} prayers, ${cache.runes?.length ?? 0} runes, ${cache.tools?.length ?? 0} tools, bank=${cache.bankPosition ? "yes" : "no"}`,
    );
  } catch (err) {
    logger.warn(
      `[WorldData] Error loading manifests: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get resources available at a given skill level.
 * Returns all resources with levelRequired <= level.
 */
export function getResourcesAtLevel(
  skill: "woodcutting" | "mining" | "fishing",
  level: number,
): ResourceEntry[] {
  ensureLoaded();

  const resources = cache[skill];
  if (!resources) return [];

  return resources.filter((r) => r.levelRequired <= level);
}

/**
 * Get the bank position from world data.
 * Returns [x, y, z] or [8, 0, 5] as hardcoded fallback.
 */
export function getBankPosition(): [number, number, number] {
  ensureLoaded();
  return cache.bankPosition ?? [8, 0, 5];
}

/**
 * Get heal amount for a food item by name (case-insensitive partial match).
 * Returns 0 if not found.
 */
export function getFoodHealAmount(itemName: string): number {
  ensureLoaded();

  if (!cache.food) return 0;
  const lower = itemName.toLowerCase();
  const match = cache.food.find(
    (f) =>
      f.name.toLowerCase() === lower ||
      f.id.toLowerCase() === lower ||
      lower.includes(f.name.toLowerCase()) ||
      lower.includes(f.id.toLowerCase()),
  );
  return match?.healAmount ?? 0;
}

/**
 * Get all monster tiers sorted by level ascending.
 */
export function getMonsterTiers(): MonsterTier[] {
  ensureLoaded();
  return cache.monsters ?? [];
}

/**
 * Get the best monster for a given combat level.
 * Returns the highest-level monster where monster.level <= combatLevel + maxAbove.
 * Falls back to the lowest-level monster (goblin).
 */
export function getMonsterForCombatLevel(
  combatLevel: number,
  maxAbove: number = 3,
): MonsterTier {
  ensureLoaded();

  const monsters = cache.monsters;
  if (!monsters || monsters.length === 0) {
    return { id: "goblin", name: "Goblin", level: 2, location: "spawn" };
  }

  // Find the highest-level monster the agent can reasonably fight
  const ceiling = combatLevel + maxAbove;
  let best = monsters[0]; // lowest level fallback
  for (const m of monsters) {
    if (m.level <= ceiling) {
      best = m;
    }
  }
  return best;
}

/**
 * Get all prayer IDs from manifest.
 * Returns empty array if manifests not loaded.
 */
export function getPrayerIds(): string[] {
  ensureLoaded();
  return cache.prayers?.map((p) => p.id) ?? [];
}

/**
 * Get manifest-authored prayers whose level requirement is satisfied.
 * Returns an empty array when the manifest is unavailable or the level is
 * malformed so autonomous callers fail closed rather than guessing content.
 */
export function getPrayersAtLevel(level: number): PrayerEntry[] {
  ensureLoaded();
  if (!Number.isSafeInteger(level) || level < 1 || !cache.prayers) return [];
  return cache.prayers.filter((prayer) => prayer.level <= level);
}

/**
 * Get rune element types from manifest (unique, non-null elements).
 * Returns empty array if manifests not loaded.
 */
export function getRuneTypes(): string[] {
  ensureLoaded();
  if (!cache.runes) return [];
  const elements = cache.runes
    .map((r) => r.element)
    .filter((e): e is string => e !== null);
  return [...new Set(elements)];
}

/**
 * Get all tool item IDs from manifest.
 */
export function getToolIds(): string[] {
  ensureLoaded();
  return cache.tools?.map((t) => t.itemId) ?? [];
}

/**
 * Get tools filtered by skill name (e.g. "woodcutting", "mining", "fishing").
 */
export function getToolsForSkill(skill: string): ToolEntry[] {
  ensureLoaded();
  return cache.tools?.filter((t) => t.skill === skill) ?? [];
}

export function getItemEntry(itemId: string): ItemEntry | null {
  ensureLoaded();
  return cache.items?.find((item) => item.id === itemId) ?? null;
}

// ---------------------------------------------------------------------------
// Gear tiers (static — derived from tier-requirements.json)
// ---------------------------------------------------------------------------

const GEAR_TIERS: GearTier[] = [
  { tierName: "bronze", levelRequired: 1, smithingLevel: 1 },
  { tierName: "iron", levelRequired: 1, smithingLevel: 15 },
  { tierName: "steel", levelRequired: 5, smithingLevel: 30 },
  { tierName: "mithril", levelRequired: 20, smithingLevel: 50 },
  { tierName: "adamant", levelRequired: 30, smithingLevel: 70 },
  { tierName: "rune", levelRequired: 40, smithingLevel: 85 },
];

/**
 * Get all gear tiers sorted by levelRequired ascending.
 */
export function getGearTiers(): GearTier[] {
  return GEAR_TIERS;
}

/**
 * Get the best gear tier the player can equip at a given attack level.
 * Returns the highest tier where levelRequired <= attackLevel.
 */
export function getBestEquippableTier(attackLevel: number): GearTier {
  let best = GEAR_TIERS[0];
  for (const tier of GEAR_TIERS) {
    if (tier.levelRequired <= attackLevel) {
      best = tier;
    }
  }
  return best;
}
