/**
 * SystemMap — typed registry for World.getSystem()
 *
 * Maps every system registration key to its concrete class so callers
 * can write `world.getSystem("combat")` and get `CombatSystem | undefined`
 * without manual casts.
 *
 * Only systems that are actively looked up via getSystem() are listed here.
 * Systems that are only accessed through World properties (e.g. world.chat)
 * don't need entries.
 */

import type { ActionRegistry } from "../systems/shared";
import type { AggroSystem } from "../systems/shared";
import type { BankingSystem } from "../systems/shared";
import type { CoinPouchSystem } from "../systems/shared";
import type { CombatSystem } from "../systems/shared";
import type { DialogueSystem } from "../systems/shared";
import type { EntityManager } from "../systems/shared";
import type { EquipmentSystem } from "../systems/shared";
import type { GravestoneLootSystem } from "../systems/shared";
import type { HealthRegenSystem } from "../systems/shared";
import type { InventoryInteractionSystem } from "../systems/shared";
import type { InventorySystem } from "../systems/shared";
import type { ItemSpawnerSystem } from "../systems/shared";
import type { LootSystem } from "../systems/shared";
import type { MobDeathSystem } from "../systems/shared";
import type { MobNPCSpawnerSystem } from "../systems/shared";
import type { MobNPCSystem } from "../systems/shared";
import type { NPCSystem } from "../systems/shared";
import type { PlayerDeathSystem } from "../systems/shared";
import type { PlayerSystem } from "../systems/shared";
import type { PrayerSystem } from "../systems/shared";
import type { ProcessingSystem } from "../systems/shared";
import type { QuestSystem } from "../systems/shared";
import type { ResourceSystem } from "../systems/shared";
import type { SkillsSystem } from "../systems/shared";
import type { SmeltingSystem } from "../systems/shared";
import type { SmithingSystem } from "../systems/shared";
import type { CraftingSystem } from "../systems/shared";
import type { FletchingSystem } from "../systems/shared";
import type { RunecraftingSystem } from "../systems/shared";
import type { StationSpawnerSystem } from "../systems/shared";
import type { StoreSystem } from "../systems/shared";
import type { TanningSystem } from "../systems/shared";
import type { GroundItemSystem } from "../systems/shared/economy/GroundItemSystem";
import type { ZoneDetectionSystem } from "../systems/shared/death/ZoneDetectionSystem";
import type { PersistenceSystem } from "../systems/server/PersistenceSystem";
import type { TerrainSystem } from "../systems/shared/world/TerrainSystem";
import type { TownSystem } from "../systems/shared/world/TownSystem";
import type { RoadNetworkSystem } from "../systems/shared/world/RoadNetworkSystem";
import type { DatabaseSystem } from "./systems/system-interfaces";

// Client systems
import type { ClientCameraSystem } from "../systems/client/ClientCameraSystem";
import type { ClientGraphics } from "../systems/client/ClientGraphics";
import type { ClientNetwork } from "../systems/client/ClientNetwork";
import type { ClientActions } from "../systems/client/ClientActions";
import type { CombatAudioSystem } from "../systems/client/CombatAudioSystem";
import type { DamageSplatSystem } from "../systems/client";
import type { DuelCountdownSplatSystem } from "../systems/client";
import type { ProjectileRenderer } from "../systems/client";
import type { SocialSystem } from "../systems/client";
import type { DuelArenaVisualsSystem } from "../systems/client";
import type { EquipmentVisualSystem } from "../systems/client";
import type { InteractionRouter } from "../systems/client";
import type { HealthBars } from "../systems/client/HealthBars";

// Shared systems accessed by key
import type { Chat } from "../systems/shared/presentation/Chat";
import type { BuildingCollisionService } from "../systems/shared/world/BuildingCollisionService";

// Core engine systems (always registered)
import type { Stage } from "../systems/shared";
import type { Physics } from "../systems/shared";
import type { Environment } from "../systems/shared";
import type { LODs } from "../systems/shared";
import type { Particles } from "../systems/shared";

/**
 * Maps system registration keys to their concrete types.
 *
 * Usage:
 * ```ts
 * // Before — manual cast:
 * const combat = world.getSystem("combat") as unknown as CombatSystem;
 *
 * // After — automatic:
 * const combat = world.getSystem("combat"); // CombatSystem | undefined
 * ```
 */
export interface SystemMap {
  // Foundational
  "action-registry": ActionRegistry;
  "entity-manager": EntityManager;
  persistence: PersistenceSystem;

  // Core entity
  player: PlayerSystem;
  "mob-npc": MobNPCSystem;

  // Combat & interaction
  combat: CombatSystem;
  "coin-pouch": CoinPouchSystem;
  inventory: InventorySystem;
  equipment: EquipmentSystem;
  skills: SkillsSystem;
  prayer: PrayerSystem;
  "health-regen": HealthRegenSystem;
  aggro: AggroSystem;

  // Economy
  banking: BankingSystem;
  store: StoreSystem;
  resource: ResourceSystem;
  "ground-items": GroundItemSystem;
  loot: LootSystem;

  // Processing / crafting
  processing: ProcessingSystem;
  smelting: SmeltingSystem;
  smithing: SmithingSystem;
  crafting: CraftingSystem;
  fletching: FletchingSystem;
  tanning: TanningSystem;
  runecrafting: RunecraftingSystem;

  // Death
  "player-death": PlayerDeathSystem;
  "gravestone-loot": GravestoneLootSystem;
  "mob-death": MobDeathSystem;

  // World content
  npc: NPCSystem;
  dialogue: DialogueSystem;
  quest: QuestSystem;
  "mob-npc-spawner": MobNPCSpawnerSystem;
  "station-spawner": StationSpawnerSystem;
  "item-spawner": ItemSpawnerSystem;
  "zone-detection": ZoneDetectionSystem;

  // Terrain & world
  terrain: TerrainSystem;
  towns: TownSystem;
  roads: RoadNetworkSystem;

  // Database (server)
  database: DatabaseSystem;

  // Core engine
  stage: Stage;
  physics: Physics;
  environment: Environment;
  lods: LODs;
  particles: Particles;

  // Client systems
  graphics: ClientGraphics;
  network: ClientNetwork;
  actions: ClientActions;
  "combat-audio": CombatAudioSystem;
  "client-camera-system": ClientCameraSystem;
  interaction: InteractionRouter;
  "inventory-interaction": InventoryInteractionSystem;
  "damage-splat": DamageSplatSystem;
  "projectile-renderer": ProjectileRenderer;
  "duel-countdown-splat": DuelCountdownSplatSystem;
  social: SocialSystem;
  "duel-arena-visuals": DuelArenaVisualsSystem;
  "equipment-visual": EquipmentVisualSystem;
  healthbars: HealthBars;

  // Shared systems with key access
  chat: Chat;
  buildingCollision: BuildingCollisionService;

  // Alias: "town" → TownSystem (some code uses "town" instead of "towns")
  town: TownSystem;
}

export type SystemKey = keyof SystemMap;
