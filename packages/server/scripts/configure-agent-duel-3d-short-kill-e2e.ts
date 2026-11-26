import pg from "pg";

const AGENT_IDS = [
  "persisted-cycle-chaos-alpha",
  "persisted-cycle-chaos-beta",
] as const;
const PREPARED_WEAPON_ID = "shortbow";
const PREPARED_ARROW_QUANTITY = 500;

const databaseUrl = process.env.AGENT_DUEL_3D_E2E_DATABASE_URL?.trim() || "";

if (!databaseUrl) {
  throw new Error("AGENT_DUEL_3D_E2E_DATABASE_URL is required");
}
if (
  process.env.AGENT_DUEL_3D_E2E_SHORT_KILL_PROFILE?.trim().toLowerCase() !==
  "true"
) {
  throw new Error(
    "AGENT_DUEL_3D_E2E_SHORT_KILL_PROFILE=true is required for the bounded local short-kill fixture",
  );
}
if (
  process.env.AGENT_DUEL_3D_E2E_MULTI_STYLE?.trim().toLowerCase() === "true"
) {
  throw new Error("the short-kill fixture requires a fixed ranged role");
}
if (
  (process.env.AGENT_DUEL_CYCLE_CHAOS_ROLE?.trim() || "ranged") !== "ranged"
) {
  throw new Error("the short-kill fixture requires the ranged role");
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

type CombatProfile = {
  agentId: (typeof AGENT_IDS)[number];
  attackLevel: number;
  strengthLevel: number;
  defenseLevel: number;
  constitutionLevel: number;
  rangedLevel: number;
  magicLevel: number;
};

function calculateCombatLevel(profile: CombatProfile): number {
  const prayerLevel = 40;
  const base =
    0.25 *
    (profile.defenseLevel +
      profile.constitutionLevel +
      Math.floor(prayerLevel / 2));
  const melee = 0.325 * (profile.attackLevel + profile.strengthLevel);
  const ranged = 0.325 * Math.floor(profile.rangedLevel * 1.5);
  const magic = 0.325 * Math.floor(profile.magicLevel * 1.5);
  return Math.max(
    3,
    Math.min(126, Math.floor(base + Math.max(melee, ranged, magic))),
  );
}

const profiles = [
  {
    agentId: AGENT_IDS[0],
    attackLevel: 1,
    strengthLevel: 1,
    defenseLevel: 99,
    constitutionLevel: 10,
    rangedLevel: 99,
    magicLevel: 1,
  },
  {
    agentId: AGENT_IDS[1],
    attackLevel: 1,
    strengthLevel: 1,
    defenseLevel: 1,
    constitutionLevel: 10,
    rangedLevel: 1,
    magicLevel: 1,
  },
].map((profile) => ({
  ...profile,
  attackXp: minimumXpForLevel(profile.attackLevel),
  strengthXp: minimumXpForLevel(profile.strengthLevel),
  defenseXp: minimumXpForLevel(profile.defenseLevel),
  constitutionXp: minimumXpForLevel(profile.constitutionLevel),
  rangedXp: minimumXpForLevel(profile.rangedLevel),
  magicXp: minimumXpForLevel(profile.magicLevel),
  health: profile.constitutionLevel,
  maxHealth: profile.constitutionLevel,
  combatLevel: calculateCombatLevel(profile),
}));

type FixtureRow = {
  id: string;
  isAgent: number;
  streamingDuelEnabled: boolean;
  weaponId: string | null;
  arrowQuantity: number;
  cookedFood: number;
  attackLevel: number;
  attackXp: number;
  strengthLevel: number;
  strengthXp: number;
  defenseLevel: number;
  defenseXp: number;
  constitutionLevel: number;
  constitutionXp: number;
  rangedLevel: number;
  rangedXp: number;
  magicLevel: number;
  magicXp: number;
  health: number;
  maxHealth: number;
  combatLevel: number;
};

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
  query_timeout: 10_000,
  application_name: "hyperia-short-kill-profile-e2e",
});

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
            character."attackLevel" AS "attackLevel",
            character."attackXp" AS "attackXp",
            character."strengthLevel" AS "strengthLevel",
            character."strengthXp" AS "strengthXp",
            character."defenseLevel" AS "defenseLevel",
            character."defenseXp" AS "defenseXp",
            character."constitutionLevel" AS "constitutionLevel",
            character."constitutionXp" AS "constitutionXp",
            character."rangedLevel" AS "rangedLevel",
            character."rangedXp" AS "rangedXp",
            character."magicLevel" AS "magicLevel",
            character."magicXp" AS "magicXp",
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
        row.weaponId !== PREPARED_WEAPON_ID ||
        row.arrowQuantity !== PREPARED_ARROW_QUANTITY ||
        row.cookedFood < 4,
    )
  ) {
    throw new Error(
      `short-kill profile requires the exact prepared two-agent ranged fixture: ${JSON.stringify(rows)}`,
    );
  }
};

const assertShortKillProfile = (rows: FixtureRow[]): void => {
  const expectedByAgent = new Map(
    profiles.map((profile) => [profile.agentId, profile]),
  );
  const numericKeys = [
    "attackLevel",
    "attackXp",
    "strengthLevel",
    "strengthXp",
    "defenseLevel",
    "defenseXp",
    "constitutionLevel",
    "constitutionXp",
    "rangedLevel",
    "rangedXp",
    "magicLevel",
    "magicXp",
    "health",
    "maxHealth",
    "combatLevel",
  ] as const;
  if (
    rows.length !== profiles.length ||
    rows.some((row) => {
      const expected = expectedByAgent.get(
        row.id as (typeof AGENT_IDS)[number],
      );
      return !expected || numericKeys.some((key) => row[key] !== expected[key]);
    })
  ) {
    throw new Error(
      `short-kill combat profile drifted: ${JSON.stringify(rows)}`,
    );
  }
};

try {
  await pool.query("BEGIN");
  try {
    const snapshots = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM streaming_duel_competitive_snapshots`,
    );
    if (snapshots.rows[0]?.count !== "0") {
      throw new Error(
        "short-kill combat profile must be installed before any competitive snapshot exists",
      );
    }

    assertPreparedFixture(await readFixture());
    for (const profile of profiles) {
      await pool.query(
        `UPDATE characters
            SET "attackLevel" = $2,
                "attackXp" = $3,
                "strengthLevel" = $4,
                "strengthXp" = $5,
                "defenseLevel" = $6,
                "defenseXp" = $7,
                "constitutionLevel" = $8,
                "constitutionXp" = $9,
                "rangedLevel" = $10,
                "rangedXp" = $11,
                "magicLevel" = $12,
                "magicXp" = $13,
                health = $14,
                "maxHealth" = $15,
                "combatLevel" = $16
          WHERE id = $1`,
        [
          profile.agentId,
          profile.attackLevel,
          profile.attackXp,
          profile.strengthLevel,
          profile.strengthXp,
          profile.defenseLevel,
          profile.defenseXp,
          profile.constitutionLevel,
          profile.constitutionXp,
          profile.rangedLevel,
          profile.rangedXp,
          profile.magicLevel,
          profile.magicXp,
          profile.health,
          profile.maxHealth,
          profile.combatLevel,
        ],
      );
    }
    const configured = await readFixture();
    assertPreparedFixture(configured);
    assertShortKillProfile(configured);
    await pool.query("COMMIT");

    process.stdout.write(
      `${JSON.stringify({
        event: "agent-duel-3d-short-kill-profile-configured",
        diagnosticBoundary: "loopback-no-money-e2e",
        combatRole: "ranged",
        preparedWeaponId: PREPARED_WEAPON_ID,
        preparedArrowQuantity: PREPARED_ARROW_QUANTITY,
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
