import pg from "pg";

const AGENT_IDS = [
  "persisted-cycle-chaos-alpha",
  "persisted-cycle-chaos-beta",
] as const;

const multiStyle =
  process.env.AGENT_DUEL_3D_E2E_MULTI_STYLE?.trim().toLowerCase() === "true";
const preparedWeaponId = multiStyle ? "bronze_shortsword" : "shortbow";
// The ranged seed deliberately carries excess arrows. Competitive
// preparation later freezes the exact fight-duration reserve and returns the
// remainder to private bank custody.
const preparedArrowQuantity = 500;

const databaseUrl = process.env.AGENT_DUEL_3D_E2E_DATABASE_URL?.trim() || "";

if (!databaseUrl) {
  throw new Error("AGENT_DUEL_3D_E2E_DATABASE_URL is required");
}
if (
  process.env.AGENT_DUEL_3D_E2E_TIMEOUT_PROFILE?.trim().toLowerCase() !== "true"
) {
  throw new Error(
    "AGENT_DUEL_3D_E2E_TIMEOUT_PROFILE=true is required for the bounded local timeout fixture",
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

function calculateFixtureCombatLevel(rangedLevel: number): number {
  const base =
    0.25 *
    (sharedSkills.defense +
      sharedSkills.hitpoints +
      Math.floor(sharedSkills.prayer / 2));
  const melee = 0.325 * (sharedSkills.attack + sharedSkills.strength);
  const ranged = 0.325 * Math.floor(rangedLevel * 1.5);
  const magic = 0.325 * Math.floor(sharedSkills.magic * 1.5);
  return Math.max(
    3,
    Math.min(126, Math.floor(base + Math.max(melee, ranged, magic))),
  );
}

const sharedSkills = {
  attack: 40,
  strength: 40,
  defense: 99,
  hitpoints: 99,
  magic: 1,
  prayer: 40,
} as const;
const profiles = [
  {
    agentId: AGENT_IDS[0],
    rangedLevel: 10,
    rangedXp: minimumXpForLevel(10),
  },
  {
    agentId: AGENT_IDS[1],
    rangedLevel: 1,
    rangedXp: 0,
  },
].map((profile) => ({
  ...profile,
  defenseLevel: sharedSkills.defense,
  defenseXp: minimumXpForLevel(sharedSkills.defense),
  constitutionLevel: sharedSkills.hitpoints,
  constitutionXp: minimumXpForLevel(sharedSkills.hitpoints),
  health: sharedSkills.hitpoints,
  maxHealth: sharedSkills.hitpoints,
  combatLevel: calculateFixtureCombatLevel(profile.rangedLevel),
}));

type FixtureRow = {
  id: string;
  isAgent: number;
  streamingDuelEnabled: boolean;
  weaponId: string | null;
  arrowQuantity: number;
  cookedFood: number;
  rangedLevel: number;
  rangedXp: number;
  defenseLevel: number;
  defenseXp: number;
  constitutionLevel: number;
  constitutionXp: number;
  health: number;
  maxHealth: number;
  combatLevel: number;
};

const readFixture = async (): Promise<FixtureRow[]> => {
  const result = await pool.query<FixtureRow>(
    `SELECT character.id,
            character."isAgent" AS "isAgent",
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
                         AND inventory."itemId" = 'shrimp'), 0)
              AS "cookedFood",
            character."rangedLevel" AS "rangedLevel",
            character."rangedXp" AS "rangedXp",
            character."defenseLevel" AS "defenseLevel",
            character."defenseXp" AS "defenseXp",
            character."constitutionLevel" AS "constitutionLevel",
            character."constitutionXp" AS "constitutionXp",
            character.health,
            character."maxHealth" AS "maxHealth",
            character."combatLevel" AS "combatLevel"
       FROM characters AS character
       JOIN agent_mappings AS mapping
         ON mapping.character_id = character.id
      WHERE character.id = ANY($1::text[])
      ORDER BY character.id
      FOR UPDATE OF character`,
    [[...AGENT_IDS]],
  );
  return result.rows;
};

const assertPreparedFixture = (rows: FixtureRow[]): void => {
  if (
    rows.length !== AGENT_IDS.length ||
    rows.some(
      (row) =>
        row.isAgent !== 1 ||
        row.streamingDuelEnabled !== true ||
        row.weaponId !== preparedWeaponId ||
        row.arrowQuantity !== preparedArrowQuantity ||
        row.cookedFood < 4,
    )
  ) {
    throw new Error(
      `timeout profile requires the exact prepared two-agent ranged fixture: ${JSON.stringify(rows)}`,
    );
  }
};

const assertTimeoutProfile = (rows: FixtureRow[]): void => {
  const expectedByAgent = new Map(
    profiles.map((profile) => [profile.agentId, profile]),
  );
  if (
    rows.length !== profiles.length ||
    rows.some((row) => {
      const expected = expectedByAgent.get(row.id);
      return (
        !expected ||
        row.rangedLevel !== expected.rangedLevel ||
        row.rangedXp !== expected.rangedXp ||
        row.defenseLevel !== expected.defenseLevel ||
        row.defenseXp !== expected.defenseXp ||
        row.constitutionLevel !== expected.constitutionLevel ||
        row.constitutionXp !== expected.constitutionXp ||
        row.health !== expected.health ||
        row.maxHealth !== expected.maxHealth ||
        row.combatLevel !== expected.combatLevel
      );
    })
  ) {
    throw new Error(`timeout combat profile drifted: ${JSON.stringify(rows)}`);
  }
};

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
  query_timeout: 10_000,
  application_name: "hyperia-timeout-profile-e2e",
});
try {
  await pool.query("BEGIN");
  try {
    const snapshots = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM streaming_duel_competitive_snapshots`,
    );
    if (snapshots.rows[0]?.count !== "0") {
      throw new Error(
        "timeout combat profile must be installed before any competitive snapshot exists",
      );
    }

    assertPreparedFixture(await readFixture());
    for (const profile of profiles) {
      await pool.query(
        `UPDATE characters
            SET "rangedLevel" = $2,
                "rangedXp" = $3,
                "defenseLevel" = $4,
                "defenseXp" = $5,
                "constitutionLevel" = $6,
                "constitutionXp" = $7,
                health = $8,
                "maxHealth" = $9,
                "combatLevel" = $10
          WHERE id = $1`,
        [
          profile.agentId,
          profile.rangedLevel,
          profile.rangedXp,
          profile.defenseLevel,
          profile.defenseXp,
          profile.constitutionLevel,
          profile.constitutionXp,
          profile.health,
          profile.maxHealth,
          profile.combatLevel,
        ],
      );
    }
    const configured = await readFixture();
    assertPreparedFixture(configured);
    assertTimeoutProfile(configured);
    await pool.query("COMMIT");

    process.stdout.write(
      `${JSON.stringify({
        event: "agent-duel-3d-timeout-profile-configured",
        diagnosticBoundary: "loopback-no-money-e2e",
        multiStyle,
        preparedWeaponId,
        preparedArrowQuantity,
        agents: configured,
        snapshotsBeforeConfiguration: 0,
      })}\n`,
    );
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
} finally {
  await pool.end();
}
