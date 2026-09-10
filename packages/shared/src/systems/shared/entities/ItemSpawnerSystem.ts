import { SystemBase } from "../infrastructure/SystemBase";
import { getSystem } from "../../../utils/SystemUtils";
import { EventType } from "../../../types/events";
import { GENERAL_STORES } from "../../../data/banks-stores";
import { getItem } from "../../../data/items";
import { ItemType } from "../../../types/index";
import { ItemRarity, EntityType } from "../../../types/entities";
import type { World } from "../../../types/index";
import type { InventoryItem, Item } from "../../../types/core/core";
// NOTE: Import directly to avoid circular dependency through barrel file
import type { EntityManager } from "./EntityManager";
import { groundToTerrain } from "../../../utils/game/EntityUtils";
import type { ItemSpawnerStats } from "../../../types/entities";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import { ticksToMs } from "../../../utils/game/CombatCalculations";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";

// Define LootItem locally - Item with quantity
type LootItem = Item & {
  quantity: number;
  rarity?: ItemRarity;
};

/**
 * ItemSpawnerSystem
 *
 * Uses EntityManager to spawn item entities instead of ItemApp objects.
 * Creates and manages all item instances across the world based on GDD specifications.
 * Handles shop items, event-driven loot spawns, and world display items.
 */
export class ItemSpawnerSystem extends SystemBase {
  private spawnedItems = new Map<string, string>(); // itemId -> entityId
  private shopItems = new Map<string, string[]>(); // storeId -> entityIds
  private worldItems = new Map<string, string[]>(); // location -> entityIds
  private chestItems = new Map<string, string[]>(); // chestId -> entityIds

  constructor(world: World) {
    super(world, {
      name: "item-spawner",
      dependencies: {
        required: ["entity-manager"], // Depends on EntityManager to spawn items
        optional: ["inventory", "loot", "store"], // Better with item systems
      },
      autoCleanup: true,
    });
  }

  // Helper method to convert Item to LootItem
  private toLootItem(item: Item, quantity = 1, rarity?: ItemRarity): LootItem {
    return {
      ...item,
      quantity,
      rarity: rarity || item.rarity,
    };
  }

  async init(): Promise<void> {
    // Set up type-safe event subscriptions for item spawning (4 listeners!)
    this.subscribe<{
      itemId: string;
      position: { x: number; y: number; z: number };
      quantity?: number;
    }>(EventType.ITEM_SPAWN_REQUEST, (data) => {
      void this.spawnItemAtLocation(data, 0).catch((error) => {
        console.error(
          `[ItemSpawnerSystem] Durable dynamic spawn rejected: ${String(error)}`,
        );
      });
    });
    this.subscribe<{ itemId: string }>(EventType.ITEM_DESPAWN, (data) =>
      this.despawnItem(data.itemId),
    );
    this.subscribe<{}>(
      EventType.ITEM_RESPAWN_SHOPS,
      async (_data) => await this.respawnShopItems(),
    );
    this.subscribe<{
      position: { x: number; y: number; z: number };
      lootTable: string[];
    }>(EventType.ITEM_SPAWN_LOOT, (data) => {
      void this.spawnLootItems(data).catch((error) => {
        console.error(
          `[ItemSpawnerSystem] Durable loot spawn rejected: ${String(error)}`,
        );
      });
    });
  }

  start(): void {
    // Only spawn items on server - clients receive entities via network
    if (!this.world.isServer) {
      return;
    }

    // Wait for terrain to be ready before spawning items
    const checkTerrainAndSpawn = async () => {
      const terrainSystem = this.world.getSystem("terrain") as
        { getHeightAt: (x: number, z: number) => number | null } | undefined;
      if (!terrainSystem) {
        console.warn(
          "[ItemSpawnerSystem] Terrain system not ready, waiting...",
        );
        setTimeout(checkTerrainAndSpawn, 500);
        return;
      }

      // Test if terrain has tiles loaded
      const testHeight = terrainSystem.getHeightAt(0, 0);
      if (!Number.isFinite(testHeight) || testHeight === null) {
        console.warn(
          "[ItemSpawnerSystem] Terrain tiles not generated yet, waiting...",
        );
        setTimeout(checkTerrainAndSpawn, 500);
        return;
      }

      // Spawn shop items at all towns (General Store inventory)
      await this.spawnShopItems();

      // Item drops are spawned via loot events (EventType.ITEM_SPAWN_LOOT)
    };

    // Start checking after a small initial delay
    setTimeout(checkTerrainAndSpawn, 1000);
  }

  private async spawnAllItemTypes(): Promise<void> {
    // Spawn shop items (tools and basic equipment)
    await this.spawnShopItems();
  }

  private async spawnShopItems(): Promise<void> {
    for (const store of Object.values(GENERAL_STORES)) {
      // Skip stores without location (position comes from NPC entity now)
      if (!store.location?.position) {
        continue;
      }

      const shopItemInstances: string[] = [];

      for (let itemIndex = 0; itemIndex < store.items.length; itemIndex++) {
        const shopItem = store.items[itemIndex];
        const itemData = getItem(shopItem.itemId);

        if (itemData) {
          // Create shop display positions - Y will be grounded to terrain
          const offsetX = (itemIndex % 3) * 1.5 - 1.5; // 3 items per row
          const offsetZ = Math.floor(itemIndex / 3) * 2 - 1; // Create rows

          const position = {
            x: store.location.position.x + offsetX,
            y: 0, // Will be grounded to terrain
            z: store.location.position.z + offsetZ,
          };

          const itemApp = await this.spawnDisplayItemFromData(
            itemData,
            position,
            "shop",
            store.name,
            itemIndex,
          );
          shopItemInstances.push(itemApp);
        }
      }

      this.shopItems.set(store.name, shopItemInstances);
    }
  }

  #lastKnownIndex: Record<string, number> = {};

  private async spawnDisplayItemFromData(
    itemData: Item,
    position: { x: number; y: number; z: number },
    spawnType: string,
    location: string,
    index: number,
  ): Promise<string> {
    if (
      this.#lastKnownIndex[itemData.type] !== undefined &&
      this.#lastKnownIndex[itemData.type] >= index
    ) {
      index = this.#lastKnownIndex[itemData.type] + 1;
    }
    this.#lastKnownIndex[itemData.type] = index;
    const itemId = `gdd_${itemData.id}_${location}_${index}`;
    // Ground item to terrain - use Infinity to allow any initial height difference
    // This is safe because we're always grounding to actual terrain height
    const groundedPosition = groundToTerrain(
      this.world,
      position,
      0.2,
      Infinity,
    );

    // VALIDATE: Check if Y position is reasonable
    if (groundedPosition.y > 100) {
      console.error(
        `[ItemSpawnerSystem] ❌ EXTREME Y after grounding for ${itemData.name}: ${groundedPosition.y.toFixed(2)}m`,
      );
      console.error(
        `  This suggests terrain height at (${position.x}, ${position.z}) is ${groundedPosition.y.toFixed(2)}m`,
      );
      console.error(`  Expected terrain height: 0-30m`);
    }

    // Create item entity via EntityManager
    const entityManager = getSystem(
      this.world,
      "entity-manager",
    ) as EntityManager;

    // Create entity config for item - ItemEntityConfig needs itemId at top level
    const entityConfig = {
      id: itemId,
      type: EntityType.ITEM,
      name: itemData.name,
      position: groundedPosition,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: false,
      interactionType: null,
      interactionDistance: 2,
      description: itemData.description || "",
      model: itemData.modelPath || null,
      // ItemEntityConfig required fields at top level
      itemId: itemData.id,
      itemType: this.getItemTypeString(itemData.type),
      quantity: 1,
      stackable: itemData.stackable,
      value: itemData.value || 0,
      weight: itemData.weight || 0,
      rarity: itemData.rarity || ItemRarity.COMMON,
      requirements: {
        level: itemData.requirements?.level || 1,
      },
      effects: [],
      armorSlot: itemData.equipSlot || null,
      examine: itemData.examine || "",
      modelPath: itemData.modelPath || "",
      iconPath: itemData.iconPath || "",
      healAmount: itemData.healAmount || 0,
      properties: {
        // Base entity properties
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: {
          current: 1,
          max: 1,
        },
        level: 1,
        // Item-specific properties
        itemId: itemData.id,
        custodyPolicy: "display_only" as const,
        harvestable: false,
        dialogue: [],
        quantity: 1,
        stackable: itemData.stackable,
        value: itemData.value || 0,
        weight: itemData.weight || 0,
        rarity: itemData.rarity,
      },
    };

    const itemEntity = await entityManager.spawnEntity(entityConfig);
    if (!itemEntity) {
      throw new Error(`Failed to spawn item: ${itemData.name}`);
    }

    // Register with systems - use grounded position, not original
    this.emitTypedEvent(EventType.ITEM_SPAWNED, {
      itemId: itemId,
      itemType: itemData.id,
      position: groundedPosition,
      spawnType: spawnType,
      location: location,
      config: entityConfig,
    });

    this.spawnedItems.set(itemId, itemEntity.id);

    return itemEntity.id;
  }

  private getItemTypeString(itemType: ItemType): string {
    switch (itemType) {
      case ItemType.WEAPON:
        return "weapon";
      case ItemType.ARMOR:
        return "armor";
      case ItemType.TOOL:
        return "tool";
      case ItemType.RESOURCE:
        return "resource";
      case ItemType.CONSUMABLE:
        return "food";
      case ItemType.CURRENCY:
        return "coins";
      case ItemType.AMMUNITION:
        return "arrow";
      default:
        return "misc";
    }
  }

  private getEquipmentByDifficulty(difficulty: number): LootItem[] {
    const equipment: LootItem[] = [];
    const itemIds: string[] = [];

    if (difficulty === 1) {
      // Bronze equipment
      itemIds.push(
        "bronze_shortsword",
        "bronze_shield",
        "bronze_helmet",
        "bronze_body",
        "bronze_legs",
        "wood_bow",
      );
    } else if (difficulty === 2) {
      // Steel equipment
      itemIds.push(
        "steel_sword",
        "steel_shield",
        "steel_helmet",
        "steel_body",
        "steel_legs",
        "oak_bow",
      );
    } else if (difficulty === 3) {
      // Mithril equipment
      itemIds.push(
        "mithril_sword",
        "mithril_shield",
        "mithril_helmet",
        "mithril_body",
        "mithril_legs",
        "willow_bow",
      );
    }

    for (const itemId of itemIds) {
      const item = getItem(itemId);
      if (item) {
        equipment.push(
          this.toLootItem(
            item,
            1,
            difficulty === 3 ? ItemRarity.RARE : ItemRarity.COMMON,
          ),
        );
      }
    }

    return equipment;
  }

  private generateChestLoot(tier: ItemRarity): LootItem[] {
    const loot: LootItem[] = [];
    const itemIds: string[] = [];

    if (tier === ItemRarity.RARE) {
      // Steel equipment and valuable items
      itemIds.push("steel_sword", "steel_helmet", "arrows", "coins");
    } else if (tier === ItemRarity.LEGENDARY) {
      // Mithril equipment and best items
      itemIds.push(
        "mithril_sword",
        "mithril_helmet",
        "mithril_body",
        "willow_bow",
        "arrows",
      );
    }

    for (const itemId of itemIds) {
      const item = getItem(itemId);
      if (item) {
        loot.push(this.toLootItem(item, itemId === "coins" ? 100 : 1, tier));
      }
    }

    return loot;
  }

  private async spawnItemAtLocation(
    data: {
      itemId: string;
      position: { x: number; y: number; z: number };
      quantity?: number;
      model?: string;
    },
    _index: number,
  ): Promise<void> {
    if (!getItem(data.itemId)) {
      throw new Error(`[ItemSpawnerSystem] Unknown item ID: ${data.itemId}`);
    }
    const sourceId = await this.requireGroundItemSystem().spawnGroundItem(
      data.itemId,
      data.quantity ?? 1,
      data.position,
      {
        despawnTime: ticksToMs(COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS),
      },
    );
    if (!sourceId) throw new Error("item_spawner_ground_custody_rejected");
  }

  private despawnItem(itemId: string): void {
    const entityId = this.spawnedItems.get(itemId);
    if (entityId) {
      this.emitTypedEvent(EventType.ENTITY_DEATH, { entityId });
      this.spawnedItems.delete(itemId);
    }
  }

  // Public method for test systems
  public async spawnItem(
    itemId: string,
    position: { x: number; y: number; z: number },
    _index: number,
    quantity: number = 1,
  ): Promise<string> {
    const itemData = getItem(itemId);
    if (!itemData) {
      throw new Error(`[ItemSpawnerSystem] Unknown item ID: ${itemId}`);
    }

    const sourceId = await this.requireGroundItemSystem().spawnGroundItem(
      itemData.id,
      quantity,
      position,
      {
        despawnTime: ticksToMs(COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS),
      },
    );
    if (!sourceId) throw new Error("item_spawner_ground_custody_rejected");
    return sourceId;
  }

  private async respawnShopItems(): Promise<void> {
    // Clear existing shop items
    for (const [_shopName, entityIds] of this.shopItems) {
      entityIds.forEach((entityId) => {
        this.emitTypedEvent(EventType.ENTITY_DEATH, { entityId });
      });
    }
    this.shopItems.clear();

    // Respawn shop items
    await this.spawnShopItems();
  }

  private async spawnLootItems(data: {
    position: { x: number; y: number; z: number };
    lootTable: string[];
  }): Promise<void> {
    const items: InventoryItem[] = [];
    for (let index = 0; index < data.lootTable.length; index++) {
      const itemId = data.lootTable[index];
      const itemData = getItem(itemId);
      if (itemData) {
        items.push({
          id: `item-spawner-loot-${index}`,
          itemId: itemData.id,
          quantity: 1,
          slot: index,
          metadata: null,
        });
      }
    }
    if (items.length === 0) return;
    const sourceIds = await this.requireGroundItemSystem().spawnGroundItems(
      items,
      data.position,
      {
        despawnTime: ticksToMs(COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS),
        scatter: false,
      },
      true,
    );
    if (sourceIds.length !== items.length) {
      throw new Error("item_spawner_ground_custody_batch_incomplete");
    }
  }

  private requireGroundItemSystem(): GroundItemSystem {
    if (!this.world.isServer) {
      throw new Error("item_spawner_ground_custody_server_only");
    }
    const groundItems = this.world.getSystem<GroundItemSystem>("ground-items");
    if (!groundItems) {
      throw new Error("item_spawner_ground_custody_unavailable");
    }
    return groundItems;
  }

  // Public API
  getSpawnedItems(): Map<string, string> {
    return this.spawnedItems;
  }

  getItemCount(): number {
    return this.spawnedItems.size;
  }

  getItemsByType(itemType: string): string[] {
    const entityManager = getSystem(
      this.world,
      "entity-manager",
    ) as EntityManager;

    const matchingEntityIds: string[] = [];
    for (const [_id, entityId] of this.spawnedItems) {
      const entity = entityManager.getEntity(entityId)!;
      const itemComponent = entity.getComponent("item_data")!;
      if (itemComponent.data.type === itemType) {
        matchingEntityIds.push(entityId);
      }
    }
    return matchingEntityIds;
  }

  getShopItems(): Map<string, string[]> {
    return this.shopItems;
  }

  getChestItems(): Map<string, string[]> {
    return this.chestItems;
  }

  getItemStats(): ItemSpawnerStats {
    const stats = {
      totalItems: this.spawnedItems.size,
      shopItems: 0,
      treasureItems: 0,
      chestItems: 0,
      resourceItems: 0,
      lootItems: 0,
      byType: {} as Record<string, number>,
    };

    const entityManager = getSystem(
      this.world,
      "entity-manager",
    ) as EntityManager;

    for (const [_itemId, entityId] of this.spawnedItems) {
      const entity = entityManager.getEntity(entityId)!;
      const itemComponent = entity.getComponent("item_data")!;
      // Count by item type
      const itemType = (itemComponent.data.type as string) || "misc";
      stats.byType[itemType] = (stats.byType[itemType] || 0) + 1;

      // Count by spawn type
      const spawnType = (itemComponent.data.spawnType as string) || "unknown";
      if (spawnType === "shop") stats.shopItems++;
      else if (spawnType === "treasure") stats.treasureItems++;
      else if (spawnType === "chest") stats.chestItems++;
      else if (spawnType === "resource") stats.resourceItems++;
      else if (spawnType === "loot") stats.lootItems++;
    }

    return stats;
  }

  // Required System lifecycle methods
  update(_dt: number): void {
    // Update item behaviors, check for respawns, etc.
  }

  /**
   * Cleanup when system is destroyed
   */
  destroy(): void {
    // Clear all spawn tracking
    this.spawnedItems.clear();
    this.shopItems.clear();
    this.worldItems.clear();
    this.chestItems.clear();

    // Call parent cleanup
    super.destroy();
  }
}
