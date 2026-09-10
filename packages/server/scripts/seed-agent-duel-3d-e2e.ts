import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg, { type PoolClient } from "pg";

import {
  AGENT_DUEL_COMBAT_ROLE,
  AGENT_DUEL_MULTI_STYLE_BANK_ITEMS,
  AGENT_DUEL_ROLE_FIXTURE,
  AGENT_DUEL_ROLE_FIXTURES,
  readAgentDuel3dE2eMultiStyle,
} from "./agent-duel-role-fixtures.js";

const AGENT_IDS = [
  "persisted-cycle-chaos-alpha",
  "persisted-cycle-chaos-beta",
] as const;
const CANONICAL_DUEL_AVATAR_URL =
  "asset://avatars/duel-candidates/duel-steve.vrm";
const STARTING_PRAYER_POINTS = 39;
const STARTING_PRAYER_UNITS = STARTING_PRAYER_POINTS * 1_000_000;

const databaseUrl = process.env.AGENT_DUEL_3D_E2E_DATABASE_URL?.trim() || "";
const ordinaryPreparation =
  process.env.AGENT_DUEL_3D_E2E_ORDINARY_PREPARATION?.trim().toLowerCase() ===
  "true";
const multiStyle = readAgentDuel3dE2eMultiStyle();

if (
  process.env.AGENT_DUEL_3D_E2E_ORDINARY_PREPARATION !== undefined &&
  !["true", "false"].includes(
    process.env.AGENT_DUEL_3D_E2E_ORDINARY_PREPARATION.trim().toLowerCase(),
  )
) {
  throw new Error(
    "AGENT_DUEL_3D_E2E_ORDINARY_PREPARATION must be true or false",
  );
}

if (!databaseUrl) {
  throw new Error("AGENT_DUEL_3D_E2E_DATABASE_URL is required");
}
if (multiStyle && AGENT_DUEL_COMBAT_ROLE !== "ranged") {
  throw new Error(
    "AGENT_DUEL_3D_E2E_MULTI_STYLE requires AGENT_DUEL_CYCLE_CHAOS_ROLE=ranged",
  );
}
function minimumXpForLevel(level: number): number {
  let cumulative = 0;
  for (let nextLevel = 2; nextLevel <= level; nextLevel += 1) {
    const increment =
      Math.floor(nextLevel - 1 + 300 * 2 ** ((nextLevel - 1) / 7)) / 4;
    cumulative = Math.floor(cumulative + increment);
  }
  return cumulative;
}

const STARTING_PRAYER_XP = minimumXpForLevel(STARTING_PRAYER_POINTS);

async function waitForPostgres(connectionString: string): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const candidate = new pg.Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 2_000,
      query_timeout: 5_000,
      application_name: "hyperia-full-3d-e2e-seed",
    });
    try {
      await candidate.query("SELECT 1");
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `temporary PostgreSQL did not become ready within 30 seconds: ${String(lastError)}`,
  );
}

async function seedAgents(client: PoolClient): Promise<void> {
  const createdAt = "2026-08-11T00:00:00.000Z";
  const level40Xp = minimumXpForLevel(40);
  const magicLevel = multiStyle
    ? AGENT_DUEL_ROLE_FIXTURES.mage.magicLevel
    : AGENT_DUEL_ROLE_FIXTURE.magicLevel;
  const roleMagicXp = minimumXpForLevel(magicLevel);
  for (const [index, agentId] of AGENT_IDS.entries()) {
    const accountId = `account-${index + 1}-${agentId}`;
    const agentName =
      index === 0 ? "Persisted Chaos Alpha" : "Persisted Chaos Beta";
    await client.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, $2, 'user', $3)`,
      [accountId, `Duel Chaos Account ${index + 1}`, createdAt],
    );
    await client.query(
      `INSERT INTO characters (
         id, "accountId", name, "isAgent", "combatLevel",
         "attackLevel", "attackXp", "strengthLevel", "strengthXp",
         "defenseLevel", "defenseXp", "constitutionLevel", "constitutionXp",
         "rangedLevel", "rangedXp", "magicLevel", "magicXp",
         "prayerLevel", "prayerXp", "prayerPoints", "prayerPointUnits", "prayerMaxPoints",
         "activePrayers", health, "maxHealth",
         "positionX", "positionY", "positionZ", avatar
       ) VALUES (
         $1, $2, $3, 1, 45,
         40, $4, 40, $4,
         40, $4, 40, $4,
         40, $4, $5, $6,
         $7, $8, $7, $9, $7,
         '[]'::jsonb, 40, 40,
         $10, 0, $10, $11
       )`,
      [
        agentId,
        accountId,
        agentName,
        level40Xp,
        magicLevel,
        roleMagicXp,
        STARTING_PRAYER_POINTS,
        STARTING_PRAYER_XP,
        STARTING_PRAYER_UNITS,
        index * 4,
        CANONICAL_DUEL_AVATAR_URL,
      ],
    );
    await client.query(
      `INSERT INTO agent_mappings (
         agent_id, account_id, character_id, agent_name,
         streaming_duel_enabled
       ) VALUES ($1, $2, $3, $4, true)`,
      [`eliza-${index + 1}-${agentId}`, accountId, agentId, agentName],
    );
    for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
      await client.query(
        `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
         VALUES ($1, 'lobster', 1, $2)`,
        [agentId, slotIndex],
      );
    }
    for (const [
      supplyIndex,
      supply,
    ] of AGENT_DUEL_ROLE_FIXTURE.inventorySupplies.entries()) {
      await client.query(
        `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
         VALUES ($1, $2, $3, $4)`,
        [agentId, supply.itemId, supply.quantity, 4 + supplyIndex],
      );
    }
    await client.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'weapon', $2, 1)`,
      [agentId, AGENT_DUEL_ROLE_FIXTURE.weaponId],
    );
    if (AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition) {
      await client.query(
        `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
         VALUES ($1, 'arrows', $2, $3)`,
        [
          agentId,
          AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition.itemId,
          AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition.quantity,
        ],
      );
    }
    if (multiStyle) {
      for (const [
        slotOffset,
        item,
      ] of AGENT_DUEL_MULTI_STYLE_BANK_ITEMS.entries()) {
        await client.query(
          `INSERT INTO bank_storage (
             "playerId", "itemId", quantity, slot, "tabIndex"
           ) VALUES ($1, $2, $3, $4, 0)`,
          [agentId, item.itemId, item.quantity, 10 + slotOffset],
        );
      }
    }
  }
}

const pool = await waitForPostgres(databaseUrl);
try {
  const migrationClient = await pool.connect();
  try {
    await migrate(drizzle(migrationClient), {
      migrationsFolder: path.resolve(
        import.meta.dirname,
        "../src/database/migrations",
      ),
    });
  } finally {
    migrationClient.release();
  }

  const seedClient = await pool.connect();
  try {
    await seedClient.query("BEGIN");
    try {
      const existingCharacters = await seedClient.query<{ id: string }>(
        `SELECT id FROM characters ORDER BY id FOR UPDATE`,
      );
      const existingSnapshots = await seedClient.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM streaming_duel_competitive_snapshots`,
      );
      if (
        existingCharacters.rows.length !== 0 ||
        existingSnapshots.rows[0]?.count !== "0"
      ) {
        throw new Error(
          "the 3D E2E seed requires a freshly migrated database with no characters or competitive snapshots",
        );
      }

      await seedAgents(seedClient);
      if (ordinaryPreparation) {
        await seedClient.query(
          `DELETE FROM inventory
            WHERE "playerId" = ANY($1::text[])
              AND "itemId" = 'lobster'`,
          [[...AGENT_IDS]],
        );
      }

      const seeded = await seedClient.query<{
        id: string;
        name: string;
        avatar: string | null;
        isAgent: number;
        magicLevel: number;
        prayerLevel: number;
        prayerXp: number;
        streamingDuelEnabled: boolean;
        weaponId: string | null;
        arrowQuantity: number;
        fireRuneQuantity: number;
        mindRuneQuantity: number;
        bankMeleeWeaponQuantity: number;
        bankMageWeaponQuantity: number;
        bankFireRuneQuantity: number;
        bankMindRuneQuantity: number;
        foodQuantity: number;
      }>(
        `SELECT character.id,
                character.name,
                character.avatar,
                character."isAgent" AS "isAgent",
                character."magicLevel" AS "magicLevel",
                character."prayerLevel" AS "prayerLevel",
                character."prayerXp" AS "prayerXp",
                mapping.streaming_duel_enabled AS "streamingDuelEnabled",
                (SELECT equipment."itemId"
                   FROM equipment
                  WHERE equipment."playerId" = character.id
                    AND equipment."slotType" = 'weapon') AS "weaponId",
                COALESCE((SELECT sum(equipment.quantity)::int
                            FROM equipment
                           WHERE equipment."playerId" = character.id
                             AND equipment."slotType" = 'arrows'
                             AND equipment."itemId" = 'bronze_arrow'), 0)
                  AS "arrowQuantity",
                COALESCE((SELECT sum(inventory.quantity)::int
                            FROM inventory
                           WHERE inventory."playerId" = character.id
                             AND inventory."itemId" = 'fire_rune'), 0)
                  AS "fireRuneQuantity",
                COALESCE((SELECT sum(inventory.quantity)::int
                            FROM inventory
                           WHERE inventory."playerId" = character.id
                             AND inventory."itemId" = 'mind_rune'), 0)
                  AS "mindRuneQuantity",
                COALESCE((SELECT sum(bank.quantity)::int
                            FROM bank_storage bank
                           WHERE bank."playerId" = character.id
                             AND bank."itemId" = 'bronze_longsword'), 0)
                  AS "bankMeleeWeaponQuantity",
                COALESCE((SELECT sum(bank.quantity)::int
                            FROM bank_storage bank
                           WHERE bank."playerId" = character.id
                             AND bank."itemId" = 'staff_of_air'), 0)
                  AS "bankMageWeaponQuantity",
                COALESCE((SELECT sum(bank.quantity)::int
                            FROM bank_storage bank
                           WHERE bank."playerId" = character.id
                             AND bank."itemId" = 'fire_rune'), 0)
                  AS "bankFireRuneQuantity",
                COALESCE((SELECT sum(bank.quantity)::int
                            FROM bank_storage bank
                           WHERE bank."playerId" = character.id
                             AND bank."itemId" = 'mind_rune'), 0)
                  AS "bankMindRuneQuantity",
                COALESCE((SELECT sum(inventory.quantity)::int
                            FROM inventory
                           WHERE inventory."playerId" = character.id
                             AND inventory."itemId" = 'lobster'), 0)
                  AS "foodQuantity"
           FROM characters character
           JOIN agent_mappings mapping ON mapping.character_id = character.id
          WHERE character.id = ANY($1::text[])
          ORDER BY character.id`,
        [[...AGENT_IDS]],
      );
      if (
        seeded.rows.length !== AGENT_IDS.length ||
        seeded.rows.some(
          (row) =>
            row.isAgent !== 1 ||
            row.streamingDuelEnabled !== true ||
            row.avatar !== CANONICAL_DUEL_AVATAR_URL ||
            row.magicLevel !==
              (multiStyle
                ? AGENT_DUEL_ROLE_FIXTURES.mage.magicLevel
                : AGENT_DUEL_ROLE_FIXTURE.magicLevel) ||
            row.prayerLevel !== STARTING_PRAYER_POINTS ||
            row.prayerXp !== STARTING_PRAYER_XP ||
            row.weaponId !== AGENT_DUEL_ROLE_FIXTURE.weaponId ||
            row.arrowQuantity !==
              (AGENT_DUEL_ROLE_FIXTURE.equippedAmmunition?.quantity ?? 0) ||
            row.fireRuneQuantity !==
              (AGENT_DUEL_ROLE_FIXTURE.inventorySupplies.find(
                (supply) => supply.itemId === "fire_rune",
              )?.quantity ?? 0) ||
            row.mindRuneQuantity !==
              (AGENT_DUEL_ROLE_FIXTURE.inventorySupplies.find(
                (supply) => supply.itemId === "mind_rune",
              )?.quantity ?? 0) ||
            row.bankMeleeWeaponQuantity !== (multiStyle ? 1 : 0) ||
            row.bankMageWeaponQuantity !== (multiStyle ? 1 : 0) ||
            row.bankFireRuneQuantity !== (multiStyle ? 500 : 0) ||
            row.bankMindRuneQuantity !== (multiStyle ? 500 : 0) ||
            row.foodQuantity !== (ordinaryPreparation ? 0 : 4),
        )
      ) {
        throw new Error(
          `3D E2E seed custody drifted: ${JSON.stringify(seeded.rows)}`,
        );
      }
      await seedClient.query("COMMIT");

      process.stdout.write(
        `${JSON.stringify({
          event: "agent-duel-3d-e2e-seeded",
          combatRole: AGENT_DUEL_COMBAT_ROLE,
          weaponId: AGENT_DUEL_ROLE_FIXTURE.weaponId,
          multiStyle,
          availableCombatRoles: multiStyle
            ? (["melee", "ranged", "mage"] as const)
            : ([AGENT_DUEL_COMBAT_ROLE] as const),
          agents: seeded.rows,
          competitiveSnapshots: 0,
          diagnostic: false,
          ordinaryPreparationRequired: ordinaryPreparation,
        })}\n`,
      );
    } catch (error) {
      await seedClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    seedClient.release();
  }
} finally {
  await pool.end();
}
