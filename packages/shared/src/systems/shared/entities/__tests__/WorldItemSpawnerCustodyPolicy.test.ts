import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function methodBody(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

describe("world item spawner custody policy", () => {
  const entityManager = source("../EntityManager.ts");
  const itemSpawner = source("../ItemSpawnerSystem.ts");
  const groundItems = source("../../economy/GroundItemSystem.ts");
  const inventory = source("../../character/InventorySystem.ts");
  const loot = source("../../economy/LootSystem.ts");
  const processing = source("../../interaction/ProcessingSystem.ts");
  const combat = source("../../combat/CombatSystem.ts");
  const itemEntity = source("../../../../entities/world/ItemEntity.ts");
  const clientEntities = source("../Entities.ts");

  it("routes the legacy ITEM_SPAWN surface through GroundItemSystem", () => {
    const body = methodBody(
      entityManager,
      "private async handleItemSpawn",
      "private handleItemPickup",
    );
    expect(body).toContain('getSystem<GroundItemSystem>("ground-items")');
    expect(body).toContain("groundItems.spawnGroundItem");
    expect(body).not.toContain("this.spawnEntity(");
    expect(body).toContain("item_spawn_ground_custody_unavailable");
    expect(body).toContain("item_spawn_ground_custody_rejected");
  });

  it("separates store displays from every claimable ItemSpawner path", () => {
    const display = methodBody(
      itemSpawner,
      "private async spawnDisplayItemFromData",
      "private getItemTypeString",
    );
    expect(display).toContain("interactable: false");
    expect(display).toContain("interactionType: null");
    expect(display).toContain('custodyPolicy: "display_only"');
    expect(display).not.toContain("custodySourceId");

    for (const [start, end] of [
      ["private async spawnItemAtLocation", "private despawnItem"],
      ["public async spawnItem", "private async respawnShopItems"],
      ["private async spawnLootItems", "private requireGroundItemSystem"],
    ]) {
      const body = methodBody(itemSpawner, start, end);
      expect(body).toMatch(/(?:spawnGroundItem|spawnGroundItems)\(/u);
      expect(body).not.toContain("spawnDisplayItemFromData(");
    }
  });

  it("labels durable presentations and carries the policy to clients", () => {
    expect(groundItems).toContain('custodyPolicy: "durable_ground"');
    expect(groundItems).toContain('custodyPolicy: "diagnostic_only"');
    expect(groundItems).toContain(
      "Refusing claimable presentation: durable source authority is incomplete",
    );
    expect(inventory).toContain('custodyPolicy !== "durable_ground"');
    expect(itemEntity).toContain(
      'buf.custodyPolicy = this.getProperty("custodyPolicy")',
    );
    expect(itemEntity).toContain(
      'buf.custodySourceId = this.getProperty("custodySourceId")',
    );
    expect(clientEntities).toContain('custodyPolicy !== "display_only"');
    expect(clientEntities).toContain('custodyPolicy !== "diagnostic_only"');
  });

  it("routes every production loot, ash, and recovered-arrow source through durable custody", () => {
    const lootBody = methodBody(
      loot,
      "private async handleMobDeath",
      "public getLootTableCount",
    );
    expect(lootBody).toContain("spawnGroundItems(");
    expect(lootBody).toContain("mob_loot_source_batch_incomplete");
    expect(lootBody).not.toContain("spawnEntity(");

    expect(processing).toContain(
      "commitProcessingFireExtinguishOperationAsync",
    );
    expect(processing).toContain("prepareDurableSourceRegistration");
    expect(processing).toContain("sourceRequest");
    expect(processing).not.toContain("markProcessingFireExtinguishedAsync");
    expect(combat).toContain("consumeArrowForProjectileAtomic(");
    expect(combat).toContain("exposeCommittedDurableSource(");
    expect(combat).not.toContain("spawnGroundItem(");
    expect(combat).toContain(
      "Committed ammunition recovery presentation failed",
    );
  });
});
