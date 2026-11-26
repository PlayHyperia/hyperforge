import { sql, type SQLWrapper } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { PlayerPersistenceUpdate } from "../shared/types";
import * as schema from "./schema";

export type GenericCharacterUpdate = PgUpdateSetSource<
  typeof schema.characters
>;

function greatest(column: SQLWrapper, value: number) {
  return sql<number>`GREATEST(${column}, ${value})`;
}

/**
 * Build the only allowed generic character-row update.
 *
 * XP, base levels, and the derived combat level are monotonic progression.
 * Atomic custody transactions can advance them while an older PlayerSystem
 * snapshot is waiting in the generic save queue, so generic saves must never
 * write those fields as exact values. Mutable health, position, currency, and
 * preferences retain ordinary last-write semantics.
 */
export function buildGenericCharacterUpdate(
  data: PlayerPersistenceUpdate,
): GenericCharacterUpdate {
  const update: GenericCharacterUpdate = {};

  if (data.name && data.name.trim().length > 0) update.name = data.name;

  if (data.combatLevel !== undefined) {
    update.combatLevel = greatest(
      schema.characters.combatLevel,
      data.combatLevel,
    );
  }
  if (data.attackLevel !== undefined) {
    update.attackLevel = greatest(
      schema.characters.attackLevel,
      data.attackLevel,
    );
  }
  if (data.strengthLevel !== undefined) {
    update.strengthLevel = greatest(
      schema.characters.strengthLevel,
      data.strengthLevel,
    );
  }
  if (data.defenseLevel !== undefined) {
    update.defenseLevel = greatest(
      schema.characters.defenseLevel,
      data.defenseLevel,
    );
  }
  if (data.constitutionLevel !== undefined) {
    update.constitutionLevel = greatest(
      schema.characters.constitutionLevel,
      data.constitutionLevel,
    );
  }
  if (data.rangedLevel !== undefined) {
    update.rangedLevel = greatest(
      schema.characters.rangedLevel,
      data.rangedLevel,
    );
  }
  if (data.magicLevel !== undefined) {
    update.magicLevel = greatest(schema.characters.magicLevel, data.magicLevel);
  }
  if (data.woodcuttingLevel !== undefined) {
    update.woodcuttingLevel = greatest(
      schema.characters.woodcuttingLevel,
      data.woodcuttingLevel,
    );
  }
  if (data.miningLevel !== undefined) {
    update.miningLevel = greatest(
      schema.characters.miningLevel,
      data.miningLevel,
    );
  }
  if (data.fishingLevel !== undefined) {
    update.fishingLevel = greatest(
      schema.characters.fishingLevel,
      data.fishingLevel,
    );
  }
  if (data.firemakingLevel !== undefined) {
    update.firemakingLevel = greatest(
      schema.characters.firemakingLevel,
      data.firemakingLevel,
    );
  }
  if (data.cookingLevel !== undefined) {
    update.cookingLevel = greatest(
      schema.characters.cookingLevel,
      data.cookingLevel,
    );
  }
  if (data.smithingLevel !== undefined) {
    update.smithingLevel = greatest(
      schema.characters.smithingLevel,
      data.smithingLevel,
    );
  }
  if (data.agilityLevel !== undefined) {
    update.agilityLevel = greatest(
      schema.characters.agilityLevel,
      data.agilityLevel,
    );
  }
  if (data.craftingLevel !== undefined) {
    update.craftingLevel = greatest(
      schema.characters.craftingLevel,
      data.craftingLevel,
    );
  }
  if (data.fletchingLevel !== undefined) {
    update.fletchingLevel = greatest(
      schema.characters.fletchingLevel,
      data.fletchingLevel,
    );
  }
  if (data.runecraftingLevel !== undefined) {
    update.runecraftingLevel = greatest(
      schema.characters.runecraftingLevel,
      data.runecraftingLevel,
    );
  }

  if (data.attackXp !== undefined) {
    update.attackXp = greatest(schema.characters.attackXp, data.attackXp);
  }
  if (data.strengthXp !== undefined) {
    update.strengthXp = greatest(schema.characters.strengthXp, data.strengthXp);
  }
  if (data.defenseXp !== undefined) {
    update.defenseXp = greatest(schema.characters.defenseXp, data.defenseXp);
  }
  if (data.constitutionXp !== undefined) {
    update.constitutionXp = greatest(
      schema.characters.constitutionXp,
      data.constitutionXp,
    );
  }
  if (data.rangedXp !== undefined) {
    update.rangedXp = greatest(schema.characters.rangedXp, data.rangedXp);
  }
  if (data.magicXp !== undefined) {
    update.magicXp = greatest(schema.characters.magicXp, data.magicXp);
  }
  if (data.woodcuttingXp !== undefined) {
    update.woodcuttingXp = greatest(
      schema.characters.woodcuttingXp,
      data.woodcuttingXp,
    );
  }
  if (data.miningXp !== undefined) {
    update.miningXp = greatest(schema.characters.miningXp, data.miningXp);
  }
  if (data.fishingXp !== undefined) {
    update.fishingXp = greatest(schema.characters.fishingXp, data.fishingXp);
  }
  if (data.firemakingXp !== undefined) {
    update.firemakingXp = greatest(
      schema.characters.firemakingXp,
      data.firemakingXp,
    );
  }
  if (data.cookingXp !== undefined) {
    update.cookingXp = greatest(schema.characters.cookingXp, data.cookingXp);
  }
  if (data.smithingXp !== undefined) {
    update.smithingXp = greatest(schema.characters.smithingXp, data.smithingXp);
  }
  if (data.agilityXp !== undefined) {
    update.agilityXp = greatest(schema.characters.agilityXp, data.agilityXp);
  }
  if (data.craftingXp !== undefined) {
    update.craftingXp = greatest(schema.characters.craftingXp, data.craftingXp);
  }
  if (data.fletchingXp !== undefined) {
    update.fletchingXp = greatest(
      schema.characters.fletchingXp,
      data.fletchingXp,
    );
  }
  if (data.runecraftingXp !== undefined) {
    update.runecraftingXp = greatest(
      schema.characters.runecraftingXp,
      data.runecraftingXp,
    );
  }

  if (data.health !== undefined) update.health = data.health;
  if (data.maxHealth !== undefined) update.maxHealth = data.maxHealth;
  if (data.coins !== undefined) update.coins = data.coins;
  if (data.positionX !== undefined) update.positionX = data.positionX;
  if (data.positionY !== undefined) update.positionY = data.positionY;
  if (data.positionZ !== undefined) update.positionZ = data.positionZ;
  if (data.autoRetaliate !== undefined) {
    update.autoRetaliate = data.autoRetaliate;
  }
  if (data.selectedSpell !== undefined) {
    update.selectedSpell = data.selectedSpell;
  }

  return update;
}
