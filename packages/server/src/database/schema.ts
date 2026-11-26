/**
 * Database Schema Definitions
 *
 * This module defines the complete database schema for Hyperia using Drizzle ORM.
 * All tables, columns, indexes, and foreign key relationships are defined here.
 *
 * **Schema Overview**:
 *
 * **Core Tables**:
 * - `config`: System-wide key-value configuration store
 * - `storage`: World-specific key-value storage
 * - `users`: Account authentication and user profiles
 * - `entities`: Serialized world objects and props
 *
 * **Character System** (classic fantasy MMORPG-inspired):
 * - `characters`: Player characters with stats, levels, XP, and position
 *   - Combat skills: attack, strength, defense, constitution (health), ranged, prayer
 *   - Gathering skills: woodcutting, fishing, firemaking, cooking
 *   - Each skill has level and XP tracking
 * - `inventory`: Player item storage (28 slots with quantities and metadata)
 * - `equipment`: Worn/wielded items (weapon, armor, etc.) by slot type
 * - `items`: Item definitions (stats, bonuses, requirements)
 *
 * **Session Tracking**:
 * - `playerSessions`: Login/logout tracking, playtime, and activity monitoring
 * - `chunkActivity`: Tracks which chunks players are in for analytics
 *
 * **World Persistence**:
 * - `worldChunks`: Persistent modifications to terrain chunks (resources, buildings)
 * - Chunks use X,Z coordinates as compound primary key
 * - Includes player count and reset flags for dynamic world management
 *
 * **Indexing Strategy**:
 * - Privy/Farcaster user lookups: Indexed on privyUserId and farcasterFid
 * - Character queries: Indexed on accountId for fast character list lookups
 *
 * **Data Types**:
 * - Timestamps: bigint (Unix milliseconds) for precision and JavaScript compatibility
 * - Positions: real (float) for sub-block precision
 * - Skills: integer for levels and XP
 *
 * **Referenced by**: All database operations (DatabaseSystem, migrations, Drizzle client)
 */

/**
 * Database Schema - PostgreSQL table definitions for Hyperia
 *
 * This file defines the entire database schema using Drizzle ORM's type-safe table builder.
 * All tables, columns, constraints, and relations are defined here.
 *
 * **Tables Overview**:
 * - `config` - Server configuration (spawn points, settings)
 * - `users` - Account authentication and roles
 * - `entities` - World entities (NPCs, items, buildings)
 * - `characters` - Player characters with stats, levels, and XP
 * - `items` - Item definitions (weapons, armor, resources)
 * - `inventory` - Player inventory items
 * - `equipment` - Equipped items by slot
 * - `worldChunks` - Persistent world modifications
 * - `playerSessions` - Login/logout tracking
 * - `chunkActivity` - Player movement through chunks
 * - `npcKills` - Player NPC kill statistics
 * - `storage` - Key-value storage for systems
 *
 * **Design Patterns**:
 * - Use bigint for timestamps (milliseconds since epoch)
 * - Use text for IDs (UUIDs as strings)
 * - Use serial for auto-incrementing PKs where appropriate
 * - Use foreign keys with cascade delete for data integrity
 *
 * **Migrations**:
 * Changes to this schema require new migrations. Run:
 * ```bash
 * pnpm --filter @hyperforge/server db:generate
 * ```
 *
 * **Referenced by**: client.ts (initialization), DatabaseSystem.ts (queries), drizzle-adapter.ts (legacy compat)
 */

import {
  pgTable,
  text,
  integer,
  doublePrecision,
  bigint,
  real,
  timestamp,
  serial,
  bigserial,
  unique,
  uniqueIndex,
  index,
  jsonb,
  boolean,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/**
 * Config Table - Server configuration settings
 *
 * Stores key-value pairs for server config like spawn points, world settings, etc.
 * Used by ServerNetwork during initialization.
 */
export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/**
 * Users Table - Account authentication and authorization
 *
 * Stores user accounts with authentication providers and roles.
 * Supports multiple auth methods (Privy, JWT, anonymous).
 *
 * Key columns:
 * - `id` - Unique user ID (often matches privyUserId for Privy users)
 * - `privyUserId` - Privy authentication ID (unique, indexed)
 * - `farcasterFid` - Farcaster Frame ID if linked (indexed)
 * - `roles` - Comma-separated roles (e.g., "admin,builder")
 * - `wallet` - Main Privy embedded wallet address (HD index 0)
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    roles: text("roles").notNull(),
    createdAt: text("createdAt").notNull(),
    avatar: text("avatar"),
    wallet: text("wallet"),
    privyUserId: text("privyUserId").unique(),
    farcasterFid: text("farcasterFid"),
  },
  (table) => ({
    privyIdx: index("idx_users_privy").on(table.privyUserId),
    farcasterIdx: index("idx_users_farcaster").on(table.farcasterFid),
  }),
);

/**
 * Entities Table - World objects and NPCs
 *
 * Stores persistent entities in the world (NPCs, items, buildings, etc.).
 * Data is serialized JSON containing position, type, and entity-specific properties.
 *
 * Note: Most entities are spawned dynamically and NOT stored here.
 * This table is for entities that need to persist across server restarts.
 */
export const entities = pgTable("entities", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: false }).defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: false }).defaultNow(),
});

/**
 * Characters Table - Player character progression and state
 *
 * This is the core persistence table for all character data including:
 * - Combat stats (attack, strength, defense, constitution, ranged)
 * - Gathering skills (woodcutting, fishing, firemaking, cooking)
 * - Experience points (XP) for all skills
 * - Health, coins, and position
 * - Login tracking (createdAt, lastLogin)
 *
 * **Design**:
 * - Each user (account) can have multiple characters
 * - character.id is the primary key (UUID)
 * - accountId links to users.id
 * - All levels default to 1, constitution defaults to 10
 * - Constitution XP starts at 1154 (level 10)
 *
 * **Skills**:
 * Combat: attack, strength, defense, constitution (health), ranged, prayer
 * Gathering: woodcutting, fishing, firemaking, cooking
 *
 * **Foreign Keys**:
 * - inventory, equipment, sessions, chunkActivity all reference characters.id
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const characters = pgTable(
  "characters",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    name: text("name").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).default(
      sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
    ),

    // Combat stats
    combatLevel: integer("combatLevel").default(3),
    attackLevel: integer("attackLevel").default(1),
    strengthLevel: integer("strengthLevel").default(1),
    defenseLevel: integer("defenseLevel").default(1),
    constitutionLevel: integer("constitutionLevel").default(10),
    rangedLevel: integer("rangedLevel").default(1),
    magicLevel: integer("magicLevel").default(1),

    // Prayer skill
    prayerLevel: integer("prayerLevel").default(1),

    // Gathering skills
    woodcuttingLevel: integer("woodcuttingLevel").default(1),
    miningLevel: integer("miningLevel").default(1),
    fishingLevel: integer("fishingLevel").default(1),
    firemakingLevel: integer("firemakingLevel").default(1),
    cookingLevel: integer("cookingLevel").default(1),
    smithingLevel: integer("smithingLevel").default(1),
    agilityLevel: integer("agilityLevel").default(1),
    craftingLevel: integer("craftingLevel").default(1),
    fletchingLevel: integer("fletchingLevel").default(1),
    runecraftingLevel: integer("runecraftingLevel").default(1),

    // Experience points
    attackXp: integer("attackXp").default(0),
    strengthXp: integer("strengthXp").default(0),
    defenseXp: integer("defenseXp").default(0),
    constitutionXp: integer("constitutionXp").default(1154),
    rangedXp: integer("rangedXp").default(0),
    magicXp: integer("magicXp").default(0),
    prayerXp: integer("prayerXp").default(0),
    woodcuttingXp: doublePrecision("woodcuttingXp").notNull().default(0),
    miningXp: doublePrecision("miningXp").notNull().default(0),
    fishingXp: doublePrecision("fishingXp").notNull().default(0),
    firemakingXp: doublePrecision("firemakingXp").notNull().default(0),
    cookingXp: doublePrecision("cookingXp").notNull().default(0),
    smithingXp: doublePrecision("smithingXp").notNull().default(0),
    agilityXp: integer("agilityXp").default(0),
    craftingXp: doublePrecision("craftingXp").notNull().default(0),
    fletchingXp: doublePrecision("fletchingXp").notNull().default(0),
    runecraftingXp: doublePrecision("runecraftingXp").notNull().default(0),

    // Prayer points (current and max)
    prayerPoints: integer("prayerPoints").default(1),
    prayerPointUnits: integer("prayerPointUnits").notNull().default(1_000_000),
    prayerMaxPoints: integer("prayerMaxPoints").notNull().default(1),

    /**
     * Active prayers stored as JSONB array of prayer ID strings.
     * Format: '["thick_skin", "burst_of_strength"]'
     * IDs must match valid entries in prayers.json manifest.
     * Empty array '[]' when no prayers are active.
     *
     * JSONB provides better performance for JSON operations and allows indexing.
     */
    activePrayers: jsonb("activePrayers").$type<string[]>().default([]),

    processingConsumableUses: jsonb("processingConsumableUses")
      .$type<Record<string, { usesPerItem: number; remainingUses: number }>>()
      .notNull()
      .default({}),

    // Status
    health: integer("health").default(100),
    maxHealth: integer("maxHealth").default(100),
    coins: integer("coins").default(0),

    // Position
    positionX: real("positionX").default(0),
    positionY: real("positionY").default(10),
    positionZ: real("positionZ").default(0),

    // Combat preferences
    attackStyle: text("attackStyle").default("accurate"),
    autoRetaliate: integer("autoRetaliate").default(1).notNull(), // 1=ON (default), 0=OFF
    selectedSpell: text("selectedSpell"), // Autocast spell ID (null = no autocast)

    lastLogin: bigint("lastLogin", { mode: "number" }).default(0),

    // Avatar and wallet
    avatar: text("avatar"),
    wallet: text("wallet"),

    // Agent flag - true if this character is controlled by an AI agent (ElizaOS)
    isAgent: integer("isAgent").default(0).notNull(), // SQLite: 0=false, 1=true

    // Bank settings
    alwaysSetPlaceholder: integer("alwaysSetPlaceholder").default(0).notNull(), // SQLite: 0=false, 1=true

    // Quest progression
    questPoints: integer("questPoints").default(0).notNull(),
  },
  (table) => ({
    accountIdx: index("idx_characters_account").on(table.accountId),
    walletIdx: index("idx_characters_wallet").on(table.wallet),
    isAgentIdx: index("idx_characters_is_agent").on(table.isAgent),
  }),
);

/**
 * Agent Mappings Table - Tracks ElizaOS agent ownership
 *
 * Maps ElizaOS agent UUIDs to Hyperia users and characters.
 * This allows the dashboard to filter agents by user since ElizaOS doesn't expose this.
 *
 * Key columns:
 * - `agentId` - ElizaOS agent UUID (primary key)
 * - `accountId` - References users.id (CASCADE DELETE)
 * - `characterId` - References characters.id (CASCADE DELETE)
 * - `agentName` - Agent name (denormalized for performance)
 * - `createdAt` - When mapping was created
 * - `updatedAt` - Last sync timestamp
 *
 * Design notes:
 * - Created when user creates an AI agent through Character Editor
 * - Deleted automatically when user/character is deleted (CASCADE)
 * - Used by Dashboard to filter "My Agents" without relying on ElizaOS API
 */
export const agentMappings = pgTable(
  "agent_mappings",
  {
    agentId: text("agent_id").primaryKey().notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    /** When false, agent is excluded from streaming duel cycles (summon + matchmaking). */
    streamingDuelEnabled: boolean("streaming_duel_enabled")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    accountIdx: index("idx_agent_mappings_account").on(table.accountId),
    characterIdx: uniqueIndex("idx_agent_mappings_character").on(
      table.characterId,
    ),
  }),
);

/**
 * Short-lived, single-use SOL wallet authentication challenges for agent credentials.
 * Raw wallet addresses, nonces, messages, and signatures are deliberately not stored.
 */
export const solanaAgentAuthChallenges = pgTable(
  "solana_agent_auth_challenges",
  {
    challengeId: text("challenge_id").primaryKey().notNull(),
    walletHash: text("wallet_hash").notNull(),
    messageHash: text("message_hash").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    configFingerprint: text("config_fingerprint").notNull(),
    agentName: text("agent_name").notNull(),
    characterId: text("character_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    failureCode: text("failure_code"),
  },
  (table) => ({
    activeWalletIdx: index("idx_solana_agent_auth_wallet_active").on(
      table.walletHash,
      table.expiresAt,
    ),
    expiryIdx: index("idx_solana_agent_auth_expiry").on(table.expiresAt),
    hashLengthsCheck: check(
      "solana_agent_auth_hash_lengths_check",
      sql`${table.walletHash} ~ '^[0-9a-f]{64}$' AND ${table.messageHash} ~ '^[0-9a-f]{64}$' AND ${table.nonceHash} ~ '^[0-9a-f]{64}$' AND ${table.configFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    lifetimeCheck: check(
      "solana_agent_auth_lifetime_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    attemptsCheck: check(
      "solana_agent_auth_attempts_check",
      sql`${table.failedAttempts} >= 0 AND ${table.failedAttempts} <= 5`,
    ),
    terminalCheck: check(
      "solana_agent_auth_terminal_check",
      sql`NOT (${table.consumedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * Revocable, single-active credential sessions for autonomous agent JWTs.
 * Raw JWTs and wallet identities are deliberately not retained.
 */
export const agentCredentialSessions = pgTable(
  "agent_credential_sessions",
  {
    sessionId: text("session_id").primaryKey().notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    authMethod: text("auth_method").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    oneActiveIdx: uniqueIndex("idx_agent_credential_sessions_one_active")
      .on(table.accountId, table.characterId)
      .where(sql`${table.revokedAt} IS NULL`),
    expiryIdx: index("idx_agent_credential_sessions_expiry").on(
      table.expiresAt,
    ),
    sessionIdCheck: check(
      "agent_credential_session_id_check",
      sql`${table.sessionId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    authMethodCheck: check(
      "agent_credential_session_auth_method_check",
      sql`${table.authMethod} IN ('sol-wallet-signature-v1', 'owner-credential-v1', 'local-diagnostic-wallet-v1', 'server-managed-agent-v1')`,
    ),
    lifetimeCheck: check(
      "agent_credential_session_lifetime_check",
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + INTERVAL '7 days'`,
    ),
    revocationCheck: check(
      "agent_credential_session_revocation_check",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedAt} >= ${table.issuedAt} AND ${table.revokedReason} IN ('rotated', 'owner_revoked', 'security_revoked'))`,
    ),
  }),
);

/**
 * Shared fixed-window counters for security-sensitive HTTP authentication.
 * Bucket keys are keyed hashes; raw client network identities are never stored.
 */
export const distributedRateLimitBuckets = pgTable(
  "distributed_rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey().notNull(),
    scope: text("scope").notNull(),
    windowMs: integer("window_ms").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requestCount: bigint("request_count", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiryIdx: index("idx_distributed_rate_limit_buckets_expiry").on(
      table.expiresAt,
    ),
    bucketKeyCheck: check(
      "distributed_rate_limit_bucket_key_check",
      sql`${table.bucketKey} ~ '^[0-9a-f]{64}$'`,
    ),
    scopeCheck: check(
      "distributed_rate_limit_scope_check",
      sql`${table.scope} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`,
    ),
    windowCheck: check(
      "distributed_rate_limit_window_check",
      sql`${table.windowMs} BETWEEN 1000 AND 3600000 AND ${table.expiresAt} = ${table.windowStartedAt} + (${table.windowMs} * INTERVAL '1 millisecond')`,
    ),
    countCheck: check(
      "distributed_rate_limit_count_check",
      sql`${table.requestCount} BETWEEN 1 AND 2147483647`,
    ),
    updatedCheck: check(
      "distributed_rate_limit_updated_check",
      sql`${table.updatedAt} >= ${table.windowStartedAt} AND ${table.updatedAt} <= ${table.expiresAt}`,
    ),
  }),
);

/**
 * Items Table - Item definitions and stats
 *
 * Defines all items in the game with their properties and requirements.
 * This is a reference table - items in inventories reference these by ID.
 *
 * Key properties:
 * - Level requirements (attackLevel, strengthLevel, etc.)
 * - Combat bonuses (attackBonus, strengthBonus, etc.)
 * - Healing value (heals)
 * - Stackability and tradability
 *
 * Note: Currently not heavily used. Item data is mostly defined in shared/items.ts.
 * This table exists for future database-driven item definitions.
 */
export const items = pgTable("items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description"),
  value: integer("value").default(0),
  weight: real("weight").default(0),
  stackable: integer("stackable").default(0),
  tradeable: integer("tradeable").default(1),

  // Level requirements
  attackLevel: integer("attackLevel"),
  strengthLevel: integer("strengthLevel"),
  defenseLevel: integer("defenseLevel"),
  rangedLevel: integer("rangedLevel"),

  // Bonuses
  attackBonus: integer("attackBonus").default(0),
  strengthBonus: integer("strengthBonus").default(0),
  defenseBonus: integer("defenseBonus").default(0),
  rangedBonus: integer("rangedBonus").default(0),

  heals: integer("heals"),
});

/**
 * Inventory Table - Player inventory items
 *
 * Stores items in a player's inventory (28 slots like classic fantasy MMORPG).
 * Each row represents one stack of items in one slot.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `itemId` - Item identifier (string, not FK to items table)
 * - `quantity` - Stack size (1+ for stackable items)
 * - `slotIndex` - Position in inventory (0-27, or -1 for unslotted)
 * - `metadata` - JSON string for item-specific data (enchantments, durability, etc.)
 *
 * Design notes:
 * - slotIndex can be -1 for items being moved (unassigned)
 * - Partial unique constraint on (playerId, slotIndex) WHERE slotIndex >= 0
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const inventory = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    itemId: text("itemId").notNull(),
    quantity: integer("quantity").default(1),
    slotIndex: integer("slotIndex").default(-1),
    metadata: text("metadata"),
  },
  (table) => ({
    // Partial unique index: only one item per slot when slotIndex >= 0
    // slotIndex = -1 means "unassigned" and can have duplicates
    playerSlotUnique: uniqueIndex("inventory_player_slot_unique")
      .on(table.playerId, table.slotIndex)
      .where(sql`"slotIndex" >= 0`),
  }),
);

/**
 * Equipment Table - Items worn/wielded by player
 *
 * Stores equipped items in specific slots (weapon, helmet, body, etc.).
 * Each slot can hold exactly one item.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `slotType` - Equipment slot ("weapon", "head", "body", "legs", "shield", etc.)
 * - `itemId` - Item equipped in this slot (null if empty)
 * - `quantity` - Usually 1 for equipment (some items like arrows may stack)
 *
 * Design notes:
 * - Unique constraint on (playerId, slotType) ensures one item per slot
 * - itemId can be null for empty slots
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const equipment = pgTable(
  "equipment",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    slotType: text("slotType").notNull(),
    itemId: text("itemId"),
    quantity: integer("quantity").default(1),
  },
  (table) => ({
    uniquePlayerSlot: unique().on(table.playerId, table.slotType),
  }),
);

/**
 * Bank Storage Table - Player bank item storage
 *
 * Stores items deposited in banks. All items stack in bank (MVP simplification).
 * Shared storage - same items accessible from any bank location.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `itemId` - Item identifier (matches inventory itemId format)
 * - `quantity` - Stack size (all items stack in bank)
 * - `slot` - Bank slot index (0-479, 480 max slots)
 * - `tabIndex` - Which tab the item belongs to (0 = main tab, 1-9 = custom tabs)
 *
 * Design notes:
 * - All items stack in bank for simplicity
 * - Unique constraint on (playerId, tabIndex, slot) ensures one item per slot per tab
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const bankStorage = pgTable(
  "bank_storage",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    itemId: text("itemId").notNull(),
    quantity: integer("quantity").default(1).notNull(),
    slot: integer("slot").default(0).notNull(),
    tabIndex: integer("tabIndex").default(0).notNull(),
  },
  (table) => ({
    uniquePlayerTabSlot: unique().on(
      table.playerId,
      table.tabIndex,
      table.slot,
    ),
    playerIdx: index("idx_bank_storage_player").on(table.playerId),
    playerTabIdx: index("idx_bank_storage_player_tab").on(
      table.playerId,
      table.tabIndex,
    ),
  }),
);

/**
 * Durable idempotency receipts for server-owned agent bank transfers.
 *
 * The row is inserted in the same transaction as the inventory/bank mutation.
 * Reusing the operation ID therefore returns the original outcome without
 * moving items a second time, including after a process restart or a lost
 * COMMIT response.
 */
export const agentBankOperations = pgTable(
  "agent_bank_operations",
  {
    operationId: text("operationId").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    bankId: text("bankId").notNull(),
    // NULL identifies ordinary physical-bank custody; a value binds this
    // immutable receipt to one duel preparation.
    preparationId: text("preparationId").references(
      () => streamingDuelPreparations.preparationId,
      { onDelete: "restrict" },
    ),
    itemId: text("itemId"),
    requestedQuantity: integer("requestedQuantity").notNull(),
    committedQuantity: integer("committedQuantity").notNull(),
    inventoryQuantityAfter: integer("inventoryQuantityAfter").notNull(),
    bankQuantityAfter: integer("bankQuantityAfter"),
    requestFingerprint: text("requestFingerprint").notNull(),
    itemCount: integer("itemCount").notNull().default(1),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    playerCreatedIdx: index("idx_agent_bank_operations_player_created").on(
      table.playerId,
      table.createdAt,
    ),
  }),
);

/** Exact private components committed by one composite bank withdrawal. */
export const agentBankOperationItems = pgTable(
  "agent_bank_operation_items",
  {
    operationId: text("operationId")
      .notNull()
      .references(() => agentBankOperations.operationId, {
        onDelete: "cascade",
      }),
    itemId: text("itemId").notNull(),
    requestedQuantity: integer("requestedQuantity").notNull(),
    committedQuantity: integer("committedQuantity").notNull(),
    inventoryQuantityAfter: integer("inventoryQuantityAfter").notNull(),
    bankQuantityAfter: integer("bankQuantityAfter").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.operationId, table.itemId] }),
  }),
);

/**
 * Immutable exactly-once receipts for server-owned agent store trades.
 *
 * Human store packets do not need a durable retry key. Autonomous purchases
 * do: this row commits atomically with the coin/inventory mutation so a lost
 * response or process restart can be reconciled without charging twice.
 */
export const agentStoreOperations = pgTable(
  "agent_store_operations",
  {
    operationId: text("operation_id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    storeId: text("store_id").notNull(),
    itemId: text("item_id").notNull(),
    requestedQuantity: integer("requested_quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    totalValue: integer("total_value").notNull(),
    coinBalanceAfter: integer("coin_balance_after").notNull(),
    inventoryQuantityAfter: integer("inventory_quantity_after").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    playerCreatedIdx: index("idx_agent_store_operations_player_created").on(
      table.playerId,
      table.createdAt,
    ),
  }),
);

/** Immutable exactly-once receipts for atomic bone custody and Prayer XP. */
export const boneBurialOperations = pgTable(
  "bone_burial_operations",
  {
    operationId: text("operation_id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    xpAmount: integer("xp_amount").notNull(),
    levelRequired: integer("level_required").notNull(),
    awardedXp: integer("awarded_xp").notNull(),
    operationCommittedXp: integer("operation_committed_xp").notNull(),
    committedLevel: integer("committed_level").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    playerCreatedIdx: index("idx_bone_burial_operations_player_created").on(
      table.playerId,
      table.createdAt,
    ),
  }),
);

/**
 * Non-replayable durable context for ordinary embedded-agent autonomy.
 *
 * A checkpoint deliberately contains no pending action or action payload.
 * After every process restart it can only be used as advisory context for a
 * fresh decision against authoritative world state.
 */
export const agentAutonomyCheckpoints = pgTable(
  "agent_autonomy_checkpoints",
  {
    characterId: text("character_id")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").default(3).notNull(),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    goal: jsonb("goal").$type<unknown>(),
    plan: jsonb("plan").$type<unknown>(),
    memories: jsonb("memories").$type<string[]>().default([]).notNull(),
    recentActionLog: jsonb("recent_action_log")
      .$type<Array<{ tick: number; action: string; result: string }>>()
      .default([])
      .notNull(),
    tickCounter: bigint("tick_counter", { mode: "number" })
      .default(0)
      .notNull(),
    lastAppliedActionType: text("last_applied_action_type"),
    lastAppliedAt: bigint("last_applied_at", { mode: "number" }),
    lastAttemptedActionType: text("last_attempted_action_type"),
    lastActionOutcome: text("last_action_outcome"),
    lastAttemptedAt: bigint("last_attempted_at", { mode: "number" }),
    requiresReassessment: boolean("requires_reassessment")
      .default(true)
      .notNull(),
    updatedAt: bigint("updated_at", { mode: "number" })
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`)
      .notNull(),
  },
  (table) => ({
    updatedAtIdx: index("idx_agent_autonomy_checkpoints_updated_at").on(
      table.updatedAt,
    ),
  }),
);

/**
 * Immutable, privacy-safe causal history for ordinary pre-selection autonomy.
 * Each non-idle action has one started edge and one terminal edge. The mutable
 * head below is coordination state only; history rows are database-protected
 * against update, delete, and truncate.
 */
export const agentAutonomyProgressionEvents = pgTable(
  "agent_autonomy_progression_events",
  {
    eventSequence: bigserial("event_sequence", {
      mode: "bigint",
    }).primaryKey(),
    eventKey: text("event_key").notNull(),
    attemptId: text("attempt_id").notNull(),
    characterId: text("character_id").notNull(),
    eventSource: text("event_source").notNull(),
    eventType: text("event_type").notNull(),
    phase: text("phase").notNull(),
    goalType: text("goal_type"),
    actionType: text("action_type").notNull(),
    decisionSource: text("decision_source").notNull(),
    actionOutcome: text("action_outcome"),
    appliedActionType: text("applied_action_type"),
    checkpointRevision: bigint("checkpoint_revision", { mode: "number" }),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    eventKeyUnique: uniqueIndex(
      "uidx_agent_autonomy_progression_events_key",
    ).on(table.eventKey),
    attemptEdgeUnique: uniqueIndex(
      "uidx_agent_autonomy_progression_events_attempt_edge",
    ).on(table.attemptId, table.eventType),
    characterSequenceIdx: index(
      "idx_agent_autonomy_progression_events_character_sequence",
    ).on(table.characterId, table.eventSequence),
    actionTimeIdx: index(
      "idx_agent_autonomy_progression_events_action_time",
    ).on(table.actionType, table.occurredAt),
    terminalCheckpointUnique: uniqueIndex(
      "uidx_agent_autonomy_progression_events_terminal_checkpoint",
    )
      .on(table.characterId, table.checkpointRevision)
      .where(sql`${table.eventType} = 'attempt_terminal'`),
  }),
);

/** One-row lock and open-attempt fence per ordinary autonomous agent. */
export const agentAutonomyProgressionHeads = pgTable(
  "agent_autonomy_progression_heads",
  {
    characterId: text("character_id")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    openAttemptId: text("open_attempt_id"),
    openPhase: text("open_phase"),
    openGoalType: text("open_goal_type"),
    openActionType: text("open_action_type"),
    openDecisionSource: text("open_decision_source"),
    openStartedAt: bigint("open_started_at", { mode: "number" }),
    headRevision: bigint("head_revision", { mode: "number" })
      .default(0)
      .notNull(),
    updatedAt: bigint("updated_at", { mode: "number" })
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`)
      .notNull(),
  },
  (table) => ({
    openAttemptUnique: uniqueIndex(
      "uidx_agent_autonomy_progression_heads_open_attempt",
    )
      .on(table.openAttemptId)
      .where(sql`${table.openAttemptId} IS NOT NULL`),
  }),
);

/**
 * Append-only, category-only lifecycle transitions for ordinary autonomy.
 * These rows deliberately omit targets, descriptions, plans, prompts, items,
 * inventory, and every other replayable/private payload.
 */
export const agentAutonomyLifecycleEvents = pgTable(
  "agent_autonomy_lifecycle_events",
  {
    eventSequence: bigserial("event_sequence", {
      mode: "bigint",
    }).primaryKey(),
    eventKey: text("event_key").notNull(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    eventSource: text("event_source").notNull(),
    eventType: text("event_type").notNull(),
    lifecycleState: text("lifecycle_state").notNull(),
    previousState: text("previous_state"),
    previousGoalType: text("previous_goal_type"),
    goalType: text("goal_type"),
    actionType: text("action_type").notNull(),
    actionOutcome: text("action_outcome"),
    checkpointRevision: bigint("checkpoint_revision", { mode: "number" }),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    eventKeyUnique: uniqueIndex("uidx_agent_autonomy_lifecycle_events_key").on(
      table.eventKey,
    ),
    characterSequenceIdx: index(
      "idx_agent_autonomy_lifecycle_events_character_sequence",
    ).on(table.characterId, table.eventSequence),
    stateTimeIdx: index("idx_agent_autonomy_lifecycle_events_state_time").on(
      table.lifecycleState,
      table.occurredAt,
    ),
  }),
);

/** Latest derived lifecycle category; immutable history remains in events. */
export const agentAutonomyLifecycleHeads = pgTable(
  "agent_autonomy_lifecycle_heads",
  {
    characterId: text("character_id")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    currentState: text("current_state").notNull().default("goal_selection"),
    currentGoalType: text("current_goal_type"),
    latestActionType: text("latest_action_type"),
    latestActionStartedAt: bigint("latest_action_started_at", {
      mode: "number",
    }),
    headRevision: bigint("head_revision", { mode: "number" })
      .default(0)
      .notNull(),
    updatedAt: bigint("updated_at", { mode: "number" })
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`)
      .notNull(),
  },
  (table) => ({
    stateUpdatedIdx: index(
      "idx_agent_autonomy_lifecycle_heads_state_updated",
    ).on(table.currentState, table.updatedAt),
  }),
);

/** Durable private preparation session that precedes every public duel market. */
export const streamingDuelPreparations = pgTable(
  "streaming_duel_preparations",
  {
    preparationId: text("preparationId").primaryKey(),
    fencingToken: bigint("fencingToken", { mode: "bigint" }).notNull(),
    agent1Id: text("agent1Id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    agent2Id: text("agent2Id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    allowedBankActions: text("allowedBankActions").array().notNull(),
    status: text("status").notNull(),
    selectedAt: bigint("selectedAt", { mode: "number" }).notNull(),
    expiresAt: bigint("expiresAt", { mode: "number" }).notNull(),
    agent1ReadyAt: bigint("agent1ReadyAt", { mode: "number" }),
    agent2ReadyAt: bigint("agent2ReadyAt", { mode: "number" }),
    agent1PlanEvidence:
      jsonb("agent1PlanEvidence").$type<Record<string, unknown>>(),
    agent2PlanEvidence:
      jsonb("agent2PlanEvidence").$type<Record<string, unknown>>(),
    frozenAt: bigint("frozenAt", { mode: "number" }),
    cancelledAt: bigint("cancelledAt", { mode: "number" }),
    cancellationReason: text("cancellationReason"),
    version: integer("version").default(1).notNull(),
  },
  (table) => ({
    activeStatusIdx: index("idx_streaming_duel_preparations_status").on(
      table.status,
      table.expiresAt,
    ),
    agent1Idx: index("idx_streaming_duel_preparations_agent1").on(
      table.agent1Id,
      table.selectedAt,
    ),
    agent2Idx: index("idx_streaming_duel_preparations_agent2").on(
      table.agent2Id,
      table.selectedAt,
    ),
  }),
);

/** Append-only cross-process reports that fence a still-private contestant. */
export const streamingDuelPreparationUnavailabilityReports = pgTable(
  "streaming_duel_preparation_unavailability_reports",
  {
    preparationId: text("preparationId")
      .notNull()
      .references(() => streamingDuelPreparations.preparationId, {
        onDelete: "restrict",
      }),
    agentId: text("agentId").notNull(),
    reason: text("reason").default("agent_unavailable").notNull(),
    reportedAt: bigint("reportedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.preparationId, table.agentId] }),
    preparationTimeIdx: index(
      "idx_streaming_duel_preparation_unavailability_reports_preparation_time",
    ).on(table.preparationId, table.reportedAt, table.agentId),
  }),
);

/** Mutable database-clock liveness boundary for each private contestant host. */
export const streamingDuelPreparationAgentHostLeases = pgTable(
  "streaming_duel_preparation_agent_host_leases",
  {
    preparationId: text("preparationId")
      .notNull()
      .references(() => streamingDuelPreparations.preparationId, {
        onDelete: "restrict",
      }),
    agentId: text("agentId").notNull(),
    ownerId: text("ownerId").notNull(),
    executableBuildId: text("executableBuildId"),
    claimedAt: bigint("claimedAt", { mode: "number" }).notNull(),
    heartbeatAt: bigint("heartbeatAt", { mode: "number" }).notNull(),
    expiresAt: bigint("expiresAt", { mode: "number" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.preparationId, table.agentId] }),
    expiryIdx: index(
      "idx_streaming_duel_preparation_agent_host_leases_expiry",
    ).on(table.preparationId, table.expiresAt, table.agentId),
  }),
);

/** Immutable public strategy context for one externally hosted contestant. */
export const streamingDuelPreparationStrategyContexts = pgTable(
  "streaming_duel_preparation_strategy_contexts",
  {
    preparationId: text("preparationId")
      .notNull()
      .references(() => streamingDuelPreparations.preparationId, {
        onDelete: "restrict",
      }),
    agentId: text("agentId").notNull(),
    hostOwnerId: text("hostOwnerId").notNull(),
    policyVersion: text("policyVersion").notNull(),
    protocolVersion: text("protocolVersion").notNull(),
    agentName: text("agentName").notNull(),
    opponentName: text("opponentName").notNull(),
    ownPublicProfile: jsonb("ownPublicProfile").$type<{
      narrative: string;
      pillars: string[];
    }>(),
    opponentPublicProfile: jsonb("opponentPublicProfile").$type<{
      narrative: string;
      pillars: string[];
    }>(),
    opponentHistorySummary: jsonb("opponentHistorySummary").$type<{
      sampleSize: number;
      observedOpponentOpeningStyleFocus: "melee" | "ranged" | "mage" | null;
      recent: Array<{
        result: "win" | "loss" | "draw";
        ownOpeningStyle: "melee" | "ranged" | "mage" | null;
        opponentOpeningStyle: "melee" | "ranged" | "mage" | null;
        winReason:
          "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw";
      }>;
    }>(),
    boundAt: bigint("boundAt", { mode: "number" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.preparationId, table.agentId] }),
    boundIdx: index(
      "idx_streaming_duel_preparation_strategy_contexts_bound",
    ).on(table.preparationId, table.boundAt, table.agentId),
  }),
);

/** Append-only, category-only public preparation journey for restart recovery. */
export const streamingDuelPreparationPublicActivities = pgTable(
  "streaming_duel_preparation_public_activities",
  {
    activitySequence: bigserial("activitySequence", {
      mode: "bigint",
    }).primaryKey(),
    preparationId: text("preparationId")
      .notNull()
      .references(() => streamingDuelPreparations.preparationId, {
        onDelete: "restrict",
      }),
    agentId: text("agentId").notNull(),
    activity: text("activity").notNull(),
    mode: text("mode").notNull(),
    occurredAt: bigint("occurredAt", { mode: "number" }).notNull(),
  },
  (table) => ({
    recentIdx: index(
      "idx_streaming_duel_preparation_public_activities_recent",
    ).on(table.preparationId, table.agentId, table.activitySequence),
  }),
);

/** Immutable successful access events for preparation-only remote banks. */
export const streamingDuelBankOpenEvents = pgTable(
  "streaming_duel_bank_open_events",
  {
    operationId: text("operationId").primaryKey(),
    preparationId: text("preparationId")
      .notNull()
      .references(() => streamingDuelPreparations.preparationId, {
        onDelete: "restrict",
      }),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    bankId: text("bankId").notNull(),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    preparationCreatedIdx: index(
      "idx_streaming_duel_bank_open_events_preparation_created",
    ).on(table.preparationId, table.createdAt),
    playerCreatedIdx: index(
      "idx_streaming_duel_bank_open_events_player_created",
    ).on(table.playerId, table.createdAt),
  }),
);

/** Immutable public evidence committed before a streaming duel market opens. */
export const streamingDuelCompetitiveSnapshots = pgTable(
  "streaming_duel_competitive_snapshots",
  {
    preparationId: text("preparationId")
      .primaryKey()
      .references(() => streamingDuelPreparations.preparationId, {
        onDelete: "cascade",
      }),
    snapshotVersion: integer("snapshotVersion").notNull(),
    cycleId: text("cycleId").notNull(),
    duelId: text("duelId").notNull(),
    duelKey: text("duelKey").notNull(),
    snapshotDigest: text("snapshotDigest").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    frozenAt: bigint("frozenAt", { mode: "number" }).notNull(),
    lockedAt: bigint("lockedAt", { mode: "number" }),
    duelStartedAt: bigint("duelStartedAt", { mode: "number" }),
    recoveredAt: bigint("recoveredAt", { mode: "number" }),
    lifecycleStatus: text("lifecycleStatus").default("frozen").notNull(),
    terminalOutcome: text("terminalOutcome"),
    terminalWinnerId: text("terminalWinnerId"),
    terminalWinReason: text("terminalWinReason"),
    terminalCancellationReason: text("terminalCancellationReason"),
    terminalSeed: text("terminalSeed"),
    terminalReplayHash: text("terminalReplayHash"),
    terminalAt: bigint("terminalAt", { mode: "number" }),
  },
  (table) => ({
    cycleIdUnique: uniqueIndex(
      "uidx_streaming_duel_competitive_snapshots_cycle",
    ).on(table.cycleId),
    duelIdUnique: uniqueIndex(
      "uidx_streaming_duel_competitive_snapshots_duel",
    ).on(table.duelId),
    duelKeyUnique: uniqueIndex(
      "uidx_streaming_duel_competitive_snapshots_key",
    ).on(table.duelKey),
    frozenAtIdx: index("idx_streaming_duel_competitive_snapshots_frozen").on(
      table.frozenAt,
    ),
    lifecycleIdx: index(
      "idx_streaming_duel_competitive_snapshots_lifecycle",
    ).on(table.lifecycleStatus, table.frozenAt),
  }),
);

/**
 * Ordered, privacy-safe lifecycle evidence for duel preparation and every
 * competitive snapshot edge. Database triggers reject mutation or truncation;
 * runtime rows are inserted atomically with the state change they describe.
 */
export const streamingDuelTransitionEvents = pgTable(
  "streaming_duel_transition_events",
  {
    eventSequence: bigserial("eventSequence", { mode: "bigint" }).primaryKey(),
    eventKey: text("eventKey")
      .notNull()
      .unique("streaming_duel_transition_events_event_key_unique"),
    eventSource: text("eventSource").notNull(),
    eventType: text("eventType").notNull(),
    preparationId: text("preparationId").notNull(),
    occurredAt: bigint("occurredAt", { mode: "number" }).notNull(),
    fencingToken: bigint("fencingToken", { mode: "bigint" }),
    preparationVersion: integer("preparationVersion"),
    agent1Id: text("agent1Id").notNull(),
    agent2Id: text("agent2Id").notNull(),
    actorAgentId: text("actorAgentId"),
    cycleId: text("cycleId"),
    duelId: text("duelId"),
    snapshotDigest: text("snapshotDigest"),
    terminalOutcome: text("terminalOutcome"),
    winnerId: text("winnerId"),
    winReason: text("winReason"),
    reason: text("reason"),
    terminalSeed: text("terminalSeed"),
    replayHash: text("replayHash"),
  },
  (table) => ({
    preparationSequenceIdx: index(
      "idx_streaming_duel_transition_events_preparation",
    ).on(table.preparationId, table.eventSequence),
    cycleSequenceIdx: index("idx_streaming_duel_transition_events_cycle")
      .on(table.cycleId, table.eventSequence)
      .where(sql`${table.cycleId} IS NOT NULL`),
    digestIdx: index("idx_streaming_duel_transition_events_digest")
      .on(table.snapshotDigest)
      .where(sql`${table.snapshotDigest} IS NOT NULL`),
    typeTimeIdx: index("idx_streaming_duel_transition_events_type_time").on(
      table.eventType,
      table.occurredAt,
    ),
  }),
);

/**
 * Mutable per-cycle allocator for the immutable public observation ledger.
 * Updating one row gives concurrent contestants a real PostgreSQL write/write
 * serialization point; deriving MAX(sequence) behind an advisory lock is not
 * safe under an already-established SERIALIZABLE snapshot.
 */
export const streamingDuelActionObservationHeads = pgTable(
  "streaming_duel_action_observation_heads",
  {
    cycleId: text("cycleId").primaryKey(),
    lastSequence: integer("lastSequence").notNull(),
  },
  (table) => ({
    identityCheck: check(
      "streaming_duel_action_observation_heads_identity_check",
      sql`length(${table.cycleId}) BETWEEN 1 AND 256
          AND ${table.cycleId} !~ '[[:cntrl:]]'
          AND ${table.lastSequence} >= 1`,
    ),
  }),
);

/**
 * Immutable, privacy-safe combat observations committed before publication to
 * the delayed spectator stream. The JSON payload is the exact shared v1
 * contract; duplicated identity columns support bounded replay and auditing.
 */
export const streamingDuelActionObservations = pgTable(
  "streaming_duel_action_observations",
  {
    eventSequence: bigserial("eventSequence", { mode: "bigint" }).primaryKey(),
    operationId: text("operationId").notNull(),
    cycleId: text("cycleId").notNull(),
    duelId: text("duelId").notNull(),
    sequence: integer("sequence").notNull(),
    observedAt: bigint("observedAt", { mode: "number" }).notNull(),
    actorId: text("actorId").notNull(),
    opponentId: text("opponentId").notNull(),
    action: text("action").notNull(),
    observation: jsonb("observation")
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => ({
    operationIdUnique: uniqueIndex(
      "uidx_streaming_duel_action_observations_operation",
    ).on(table.operationId),
    cycleSequenceUnique: uniqueIndex(
      "uidx_streaming_duel_action_observations_cycle_sequence",
    ).on(table.cycleId, table.sequence),
    duelSequenceIdx: index(
      "idx_streaming_duel_action_observations_duel_sequence",
    ).on(table.duelId, table.sequence),
    observedAtIdx: index(
      "idx_streaming_duel_action_observations_observed_at",
    ).on(table.observedAt),
  }),
);

/**
 * Bank Tabs Table - Custom bank tab configuration
 *
 * Stores custom bank tabs created by players (classic MMORPG-style).
 * Tab 0 (main tab) is implicit and not stored here.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `tabIndex` - Tab position (1-9, main tab 0 is implicit)
 * - `iconItemId` - Item ID used for tab icon (first item deposited)
 *
 * Design notes:
 * - Max 9 custom tabs per player (1-9)
 * - Unique constraint on (playerId, tabIndex)
 * - Tab icon defaults to first item in tab
 * - Empty tabs auto-delete (handled in application logic)
 */
export const bankTabs = pgTable(
  "bank_tabs",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    tabIndex: integer("tabIndex").notNull(),
    iconItemId: text("iconItemId"),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    uniquePlayerTab: unique().on(table.playerId, table.tabIndex),
    playerIdx: index("idx_bank_tabs_player").on(table.playerId),
  }),
);

/**
 * Bank Placeholders Table - Reserved item slots (classic MMORPG-style)
 *
 * Stores placeholders for items that have been withdrawn.
 * When a player withdraws all of an item with placeholders enabled,
 * a placeholder is created to reserve that slot for the item.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `tabIndex` - Which tab the placeholder is in (0-9)
 * - `slot` - Bank slot index where item was
 * - `itemId` - The item that was withdrawn
 *
 * Design notes:
 * - Created when withdrawing ALL of an item (with setting enabled)
 * - Deleted when depositing that item type (uses placeholder slot)
 * - Can be manually released by player
 * - Unique constraint on (playerId, tabIndex, slot)
 */
export const bankPlaceholders = pgTable(
  "bank_placeholders",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    tabIndex: integer("tabIndex").default(0).notNull(),
    slot: integer("slot").notNull(),
    itemId: text("itemId").notNull(),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    uniquePlayerTabSlot: unique().on(
      table.playerId,
      table.tabIndex,
      table.slot,
    ),
    playerIdx: index("idx_bank_placeholders_player").on(table.playerId),
    playerItemIdx: index("idx_bank_placeholders_player_item").on(
      table.playerId,
      table.itemId,
    ),
  }),
);

/**
 * World Chunks Table - Persistent world state
 *
 * Stores modifications to world chunks (resources, buildings, terrain changes).
 * Each chunk is identified by X,Z coordinates.
 *
 * Key columns:
 * - `chunkX`, `chunkZ` - Chunk coordinates (composite key)
 * - `data` - Serialized chunk data (JSON string)
 * - `lastActive` - Timestamp of last player activity in chunk
 * - `playerCount` - Number of players currently in chunk
 * - `needsReset` - Flag to mark chunk for regeneration (1=true, 0=false)
 *
 * Design notes:
 * - Unique constraint on (chunkX, chunkZ)
 * - Chunks not in this table use default procedural generation
 * - lastActive used for garbage collection of old chunks
 */
export const worldChunks = pgTable(
  "world_chunks",
  {
    chunkX: integer("chunkX").notNull(),
    chunkZ: integer("chunkZ").notNull(),
    data: text("data").notNull(),
    lastActive: bigint("lastActive", { mode: "number" }).default(
      sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
    ),
    playerCount: integer("playerCount").default(0),
    version: integer("version").default(1),
    needsReset: integer("needsReset").default(0),
  },
  (table) => ({
    pk: unique().on(table.chunkX, table.chunkZ),
  }),
);

/**
 * Player Sessions Table - Login/logout tracking and analytics
 *
 * Tracks when players join and leave the server for analytics and idle detection.
 * One row per gaming session.
 *
 * Key columns:
 * - `id` - Session ID (primary key)
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `sessionStart` - Login timestamp (milliseconds)
 * - `sessionEnd` - Logout timestamp (null while active)
 * - `playtimeMinutes` - Total session duration
 * - `lastActivity` - Last action timestamp (for idle detection)
 * - `reason` - Disconnect reason ("normal", "timeout", "kick", etc.)
 *
 * Design notes:
 * - sessionEnd is null for active sessions
 * - Used for analytics, playtime tracking, and idle player detection
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const playerSessions = pgTable("player_sessions", {
  id: text("id").primaryKey(),
  playerId: text("playerId")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  sessionStart: bigint("sessionStart", { mode: "number" }).notNull(),
  sessionEnd: bigint("sessionEnd", { mode: "number" }),
  playtimeMinutes: integer("playtimeMinutes").default(0),
  reason: text("reason"),
  lastActivity: bigint("lastActivity", { mode: "number" }).default(0),
});

/**
 * Chunk Activity Table - Player movement tracking
 *
 * Records when players enter and exit chunks for analytics and chunk management.
 * Used to determine which chunks are active and should remain loaded.
 *
 * Key columns:
 * - `chunkX`, `chunkZ` - Chunk coordinates
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `entryTime` - When player entered chunk (milliseconds)
 * - `exitTime` - When player left chunk (null while in chunk)
 *
 * Design notes:
 * - exitTime is null while player is still in the chunk
 * - Used for chunk loading/unloading decisions
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const chunkActivity = pgTable("chunk_activity", {
  id: serial("id").primaryKey(),
  chunkX: integer("chunkX").notNull(),
  chunkZ: integer("chunkZ").notNull(),
  playerId: text("playerId")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  entryTime: bigint("entryTime", { mode: "number" }).notNull(),
  exitTime: bigint("exitTime", { mode: "number" }),
});

/**
 * Storage Table - Generic key-value persistence
 *
 * Provides simple key-value storage for systems that need to persist state.
 * Used by the Storage system for miscellaneous data that doesn't fit other tables.
 *
 * Key columns:
 * - `key` - Unique identifier (primary key)
 * - `value` - Arbitrary data (JSON string)
 * - `updatedAt` - Last modification timestamp
 *
 * Usage examples:
 * - System preferences
 * - Feature flags
 * - Temporary state that doesn't warrant its own table
 */
export const storage = pgTable("storage", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).default(
    sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
  ),
});

/** Durable, database-time lease used to elect exactly one streaming scheduler. */
export const streamingSchedulerLeases = pgTable("streaming_scheduler_leases", {
  leaseName: text("lease_name").primaryKey(),
  holderId: text("holder_id").notNull(),
  fencingToken: bigint("fencing_token", { mode: "bigint" })
    .notNull()
    .default(1n),
  acquiredAt: bigint("acquired_at", { mode: "number" }).notNull(),
  renewedAt: bigint("renewed_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

/**
 * NPC Kills Table - Player kill statistics
 *
 * Tracks how many times each player has killed each NPC type.
 * Used for achievements, quests, and player statistics.
 *
 * Key columns:
 * - `id` - Auto-incrementing primary key
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `npcId` - The NPC type identifier (e.g., "goblin", "dragon")
 * - `killCount` - Number of times this player has killed this NPC type
 *
 * Design notes:
 * - Unique constraint on (playerId, npcId) ensures one row per player per NPC type
 * - killCount increments each time the player kills that NPC type
 * - CASCADE DELETE ensures cleanup when character is deleted
 * - Indexed on playerId for fast lookups of player kill stats
 */
export const npcKills = pgTable(
  "npc_kills",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    npcId: text("npcId").notNull(),
    killCount: integer("killCount").default(1).notNull(),
  },
  (table) => ({
    uniquePlayerNpc: unique().on(table.playerId, table.npcId),
    playerIdx: index("idx_npc_kills_player").on(table.playerId),
  }),
);

/**
 * Quest Progress Table - Player quest state tracking
 *
 * Tracks quest progress for each player. Each row represents a player's
 * progress on a specific quest.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `questId` - Quest identifier from quests.json manifest
 * - `status` - "not_started" | "in_progress" | "completed"
 * - `currentStage` - Current stage ID within the quest
 * - `stageProgress` - JSON object tracking stage-specific progress (e.g., {"kills": 7})
 * - `startedAt` - Unix timestamp when quest was started
 * - `completedAt` - Unix timestamp when quest was completed
 *
 * Note: "ready_to_complete" is a derived state computed by QuestSystem when
 * status is "in_progress" AND the current stage objective is met.
 */
export const questProgress = pgTable(
  "quest_progress",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("questId").notNull(),
    status: text("status").default("not_started").notNull(),
    currentStage: text("currentStage"),
    stageProgress: jsonb("stageProgress").default({}),
    startedAt: bigint("startedAt", { mode: "number" }),
    completedAt: bigint("completedAt", { mode: "number" }),
  },
  (table) => ({
    uniquePlayerQuest: unique().on(table.playerId, table.questId),
    playerIdx: index("idx_quest_progress_player").on(table.playerId),
    statusIdx: index("idx_quest_progress_status").on(
      table.playerId,
      table.status,
    ),
  }),
);

/**
 * Player Deaths Table - Active death lock tracking
 *
 * Stores death locks for players who have died and need to retrieve their items.
 * CRITICAL: This table prevents item duplication exploits on server restart.
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `gravestoneId` - ID of gravestone entity (nullable if wilderness death)
 * - `groundItemIds` - JSON array of ground item entity IDs
 * - `position` - JSON object {x, y, z} of death location
 * - `timestamp` - When player died (Unix milliseconds)
 * - `zoneType` - "safe_area" | "wilderness" | "pvp_zone"
 * - `itemCount` - Number of items dropped (for cleanup validation)
 *
 * **Security**: Server restart loads these records to restore death state.
 * Without this table, server restart = item duplication exploit.
 *
 * **Lifecycle**: Row created on death, deleted when player respawns or loots all items.
 */
export const playerDeaths = pgTable(
  "player_deaths",
  {
    playerId: text("playerId")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    gravestoneId: text("gravestoneId"),
    groundItemIds: text("groundItemIds"), // JSON array: ["item1", "item2", ...]
    position: text("position").notNull(), // JSON: {"x": 0, "y": 0, "z": 0}
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    zoneType: text("zoneType").notNull(), // "safe_area" | "wilderness" | "pvp_zone"
    itemCount: integer("itemCount").default(0).notNull(),
    // Crash recovery columns
    items: jsonb("items")
      .default(sql`'[]'::jsonb`)
      .notNull(), // Array of {itemId, quantity} for recovery
    keptItems: jsonb("keptItems")
      .default(sql`'[]'::jsonb`)
      .notNull(), // Conserved safe-area items returned atomically on respawn
    deathOperationId: text("deathOperationId").references(
      () => operationsLog.id,
      { onDelete: "restrict" },
    ), // Immutable operations_log identity for this death custody snapshot
    killedBy: text("killedBy").default("unknown").notNull(), // What killed the player
    recovered: boolean("recovered").default(false).notNull(), // Whether death was processed during crash recovery
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    updatedAt: bigint("updatedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    timestampIdx: index("idx_player_deaths_timestamp").on(table.timestamp),
    recoveredIdx: index("idx_player_deaths_recovered").on(table.recovered),
    recoveryLookupIdx: index("idx_player_deaths_recovery_lookup").on(
      table.recovered,
      table.timestamp,
    ),
    deathOperationIdUnique: uniqueIndex(
      "player_deaths_death_operation_id_unique",
    )
      .on(table.deathOperationId)
      .where(sql`${table.deathOperationId} IS NOT NULL`),
  }),
);

/**
 * Character Templates Table - Pre-configured character archetypes
 *
 * Stores template configurations for character creation (Skiller, Ironman, etc.).
 * Players can choose from these templates when creating a new character.
 *
 * Key columns:
 * - `id` - Auto-incrementing primary key
 * - `name` - Template name (e.g., "The Skiller", "PvM Slayer")
 * - `description` - Template description shown in character select
 * - `emoji` - Icon emoji for the template
 * - `templateUrl` - URL to ElizaOS character config JSON (unique)
 * - `createdAt` - When template was created
 *
 * Design notes:
 * - Templates are seeded during initial setup
 * - templateUrl must be unique (constraint enforced)
 * - Used by CharacterSelectScreen to show available archetypes
 */
export const characterTemplates = pgTable(
  "character_templates",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    emoji: text("emoji").notNull(),
    templateUrl: text("templateUrl").notNull(),
    // Full ElizaOS character configuration stored as JSON string
    // This contains the complete character template that gets merged with user-specific data
    templateConfig: text("templateConfig"),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    uniqueTemplateUrl: unique().on(table.templateUrl),
  }),
);

/**
 * Layout Presets Table - User interface layout presets
 *
 * Stores UI layout configurations for players (modern MMORPG-style NIS presets).
 * Each user can have up to 4 preset slots for different activities.
 *
 * Key columns:
 * - `userId` - References users.id (CASCADE DELETE)
 * - `slotIndex` - Preset slot (0-3)
 * - `name` - User-defined preset name
 * - `layoutData` - JSON string containing window positions, tabs, etc.
 * - `resolution` - JSON object with original resolution for scaling
 * - `shared` - Whether this preset is publicly shareable
 *
 * Design notes:
 * - Max 4 presets per user (slot 0-3)
 * - Unique constraint on (userId, slotIndex)
 * - CASCADE DELETE ensures cleanup when user is deleted
 * - layoutData stores serialized WindowState[] from the UI system
 */
export const layoutPresets = pgTable(
  "layout_presets",
  {
    id: serial("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slotIndex: integer("slotIndex").notNull(),
    name: text("name").notNull(),
    layoutData: text("layoutData").notNull(), // JSON: WindowState[]
    resolution: text("resolution"), // JSON: { width, height }
    shared: integer("shared").default(0).notNull(), // 0=private, 1=shared
    // Community sharing columns
    shareCode: text("shareCode").unique(), // Unique share code for loading
    description: text("description"), // Optional description
    category: text("category").default("custom"), // Preset category
    tags: text("tags").default("[]"), // JSON array of tags
    usageCount: integer("usageCount").default(0), // Times this preset was loaded
    rating: real("rating"), // Average rating (0-5)
    ratingCount: integer("ratingCount").default(0), // Number of ratings
    ratingSum: integer("ratingSum").default(0), // Sum of all ratings
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    updatedAt: bigint("updatedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    uniqueUserSlot: unique().on(table.userId, table.slotIndex),
    userIdx: index("idx_layout_presets_user").on(table.userId),
    sharedIdx: index("idx_layout_presets_shared").on(table.shared),
    shareCodeIdx: index("idx_layout_presets_share_code").on(table.shareCode),
    communityIdx: index("idx_layout_presets_community").on(
      table.shared,
      table.usageCount,
      table.rating,
    ),
  }),
);

/**
 * Action Bar Storage Table - Persistent action bar configurations
 *
 * Stores action bar slot configurations for characters.
 * Each character can have multiple action bars (barId 0-3).
 *
 * Key columns:
 * - `playerId` - References characters.id (CASCADE DELETE)
 * - `barId` - Action bar index (0-3, with 0 being the main bar)
 * - `slotCount` - Number of visible slots (4-9)
 * - `slotsData` - JSON array of slot contents
 *
 * Design notes:
 * - slotsData stores ActionBarSlotContent[] as JSON
 * - Unique constraint on (playerId, barId)
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const actionBarStorage = pgTable(
  "action_bar_storage",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    barId: integer("barId").default(0).notNull(),
    slotCount: integer("slotCount").default(7).notNull(),
    slotsData: text("slotsData").notNull(), // JSON: ActionBarSlotContent[]
    updatedAt: bigint("updatedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    uniquePlayerBar: unique().on(table.playerId, table.barId),
    playerIdx: index("idx_action_bar_storage_player").on(table.playerId),
  }),
);

/**
 * User Bans Table - Tracks banned users
 *
 * Stores ban records for users who have been banned by moderators or admins.
 * Supports both temporary and permanent bans.
 *
 * Key columns:
 * - `id` - Auto-incrementing primary key
 * - `bannedUserId` - References users.id (the banned user)
 * - `bannedByUserId` - References users.id (the mod/admin who banned them)
 * - `reason` - Optional reason for the ban
 * - `expiresAt` - When the ban expires (null for permanent bans)
 * - `createdAt` - When the ban was created
 * - `active` - Whether the ban is currently active (false = unbanned)
 *
 * Design notes:
 * - `active` flag allows soft-delete of bans (preserves history)
 * - expiresAt = null means permanent ban
 * - Ban checks should filter by active=true AND (expiresAt IS NULL OR expiresAt > NOW())
 * - Mods cannot ban other mods or admins (enforced in application logic)
 */
export const userBans = pgTable(
  "user_bans",
  {
    id: serial("id").primaryKey(),
    bannedUserId: text("bannedUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bannedByUserId: text("bannedByUserId")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    expiresAt: bigint("expiresAt", { mode: "number" }), // null = permanent
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    active: integer("active").default(1).notNull(), // 1=active, 0=unbanned
  },
  (table) => ({
    bannedUserIdx: index("idx_user_bans_banned_user").on(table.bannedUserId),
    activeIdx: index("idx_user_bans_active").on(table.active),
    activeBannedIdx: index("idx_user_bans_active_banned").on(
      table.active,
      table.bannedUserId,
    ),
  }),
);

/**
 * Operations Log Table - Write-Ahead Logging for Persistence Operations
 *
 * Provides durability guarantees for critical operations (inventory, equipment, trades).
 * Operations are logged before execution - on crash recovery, incomplete operations
 * can be replayed to ensure no data loss.
 *
 * **Pattern**: Write-Ahead Log (WAL)
 * 1. Log operation intent with state
 * 2. Execute operation
 * 3. Mark operation complete
 * 4. On startup, replay any incomplete operations
 *
 * **Use Cases**:
 * - Trade completions
 * - Bank transactions
 * - Equipment changes
 * - Inventory modifications
 */
export const operationsLog = pgTable(
  "operations_log",
  {
    id: text("id").primaryKey(), // UUID
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    operationType: text("operationType").notNull(), // 'trade', 'bank', 'equipment', 'inventory'
    operationState: jsonb("operationState").notNull(), // Full operation data for replay
    completed: boolean("completed").default(false),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    completedAt: bigint("completedAt", { mode: "number" }),
  },
  (table) => ({
    // Index for recovery queries - find incomplete operations for a player
    incompleteIdx: index("idx_operations_log_incomplete").on(
      table.playerId,
      table.completed,
    ),
    // Index for cleanup queries - find old completed operations
    timestampIdx: index("idx_operations_log_timestamp").on(table.timestamp),
    projectileCostCustodyUnresolvedIdx: index(
      "idx_operations_log_projectile_cost_custody_unresolved",
    )
      .on(table.operationType, table.timestamp)
      .where(
        sql`${table.operationType} IN ('ammunition_shot', 'projectile_rune_cost') AND (${table.completed} = false OR ${table.operationState}->>'status' IN ('pending', 'fired'))`,
      ),
    // A ground source occurrence can cross process boundaries but may transfer
    // custody exactly once, regardless of how many authorities race it.
    groundItemPickupSourceUnique: uniqueIndex(
      "uidx_operations_log_ground_item_pickup_source",
    )
      .on(sql<string>`${table.operationState}->>'sourceEntityId'`)
      .where(
        sql`${table.operationType} = 'ground_item_pickup' AND ${table.completed} = true`,
      ),
  }),
);

/**
 * Durable ground-source occurrences. Presentation is derived from these rows;
 * the database row is committed before an entity may become interactable.
 */
export const groundItemSources = pgTable(
  "ground_item_sources",
  {
    sourceId: text("source_id").primaryKey(),
    status: text("status").notNull().default("active"),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    stackable: boolean("stackable").notNull(),
    positionX: doublePrecision("position_x").notNull(),
    positionY: doublePrecision("position_y").notNull(),
    positionZ: doublePrecision("position_z").notNull(),
    tileX: integer("tile_x").notNull(),
    tileZ: integer("tile_z").notNull(),
    droppedBy: text("dropped_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    lootProtectionExpiresAt: bigint("loot_protection_expires_at", {
      mode: "number",
    }),
    claimedByOperationId: text("claimed_by_operation_id"),
    claimedByPlayerId: text("claimed_by_player_id"),
    claimedAt: bigint("claimed_at", { mode: "number" }),
    version: integer("version").notNull().default(1),
  },
  (table) => ({
    activeExpiryIdx: index("idx_ground_item_sources_active_expiry").on(
      table.status,
      table.expiresAt,
      table.sourceId,
    ),
    activeMergeIdx: index("idx_ground_item_sources_active_merge").on(
      table.status,
      table.tileX,
      table.tileZ,
      table.itemId,
      table.droppedBy,
      table.expiresAt,
    ),
    claimedOperationUnique: uniqueIndex(
      "uidx_ground_item_sources_claimed_operation",
    )
      .on(table.claimedByOperationId)
      .where(sql`${table.claimedByOperationId} IS NOT NULL`),
    statusCheck: check(
      "ground_item_sources_status_check",
      sql`${table.status} IN ('active', 'claimed', 'expired')`,
    ),
    identityCheck: check(
      "ground_item_sources_identity_check",
      sql`${table.sourceId} ~ '^ground_item_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND length(${table.itemId}) BETWEEN 1 AND 256 AND (${table.droppedBy} IS NULL OR length(${table.droppedBy}) BETWEEN 1 AND 128)`,
    ),
    quantityCheck: check(
      "ground_item_sources_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 2147483647`,
    ),
    lifetimeCheck: check(
      "ground_item_sources_lifetime_check",
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt} AND ${table.expiresAt} > ${table.createdAt} AND (${table.lootProtectionExpiresAt} IS NULL OR ${table.lootProtectionExpiresAt} BETWEEN ${table.createdAt} AND ${table.expiresAt})`,
    ),
    positionCheck: check(
      "ground_item_sources_position_check",
      sql`${table.positionX} > '-Infinity'::double precision AND ${table.positionX} < 'Infinity'::double precision AND ${table.positionY} > '-Infinity'::double precision AND ${table.positionY} < 'Infinity'::double precision AND ${table.positionZ} > '-Infinity'::double precision AND ${table.positionZ} < 'Infinity'::double precision`,
    ),
    claimCheck: check(
      "ground_item_sources_claim_check",
      sql`(${table.status} = 'claimed' AND ${table.claimedByOperationId} IS NOT NULL AND ${table.claimedByPlayerId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL) OR (${table.status} <> 'claimed' AND ${table.claimedByOperationId} IS NULL AND ${table.claimedByPlayerId} IS NULL AND ${table.claimedAt} IS NULL)`,
    ),
    versionCheck: check(
      "ground_item_sources_version_check",
      sql`${table.version} >= 1`,
    ),
  }),
);

/** Immutable idempotency identities for every contribution, including merges. */
export const groundItemSourceContributions = pgTable(
  "ground_item_source_contributions",
  {
    contributionId: text("contribution_id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => groundItemSources.sourceId, { onDelete: "restrict" }),
    requestFingerprint: text("request_fingerprint").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    contributedAt: bigint("contributed_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    sourceIdx: index("idx_ground_item_source_contributions_source").on(
      table.sourceId,
      table.contributedAt,
      table.contributionId,
    ),
    identityCheck: check(
      "ground_item_source_contributions_identity_check",
      sql`${table.contributionId} ~ '^ground-item-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${table.requestFingerprint} ~ '^[0-9a-f]{64}$' AND length(${table.itemId}) BETWEEN 1 AND 256`,
    ),
    quantityCheck: check(
      "ground_item_source_contributions_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 2147483647`,
    ),
  }),
);

/**
 * Permanent minimal replay identities for prayer operations whose full WAL
 * payload has been compacted after an explicitly approved cutoff. These rows
 * deliberately do not reference characters: deleting a character must not
 * make an old operation ID reusable.
 */
export const compactedPrayerStateReceipts = pgTable(
  "compacted_prayer_state_receipts",
  {
    operationId: text("operation_id").primaryKey(),
    playerId: text("player_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    transition: text("transition").notNull(),
    publicObservationOperationId: text("public_observation_operation_id"),
    retentionApprovalId: text("retention_approval_id").notNull(),
    compactionBatchId: text("compaction_batch_id").notNull(),
    operationTimestamp: bigint("operation_timestamp", {
      mode: "number",
    }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }).notNull(),
    compactedAt: bigint("compacted_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    playerCompletedIdx: index(
      "idx_compacted_prayer_state_receipts_player_completed",
    ).on(table.playerId, table.completedAt),
    completedIdx: index("idx_compacted_prayer_state_receipts_completed").on(
      table.completedAt,
    ),
    batchIdx: index("idx_compacted_prayer_state_receipts_batch").on(
      table.compactionBatchId,
    ),
  }),
);

/**
 * Current authoritative depletion deadline for stable gathering nodes. The
 * row is replaced only by a later successful depletion; its matching
 * immutable semantic receipt remains in operations_log.
 */
export const gatheringResourceStates = pgTable(
  "gathering_resource_states",
  {
    resourceId: text("resource_id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operationsLog.id, { onDelete: "restrict" }),
    depletedAt: bigint("depleted_at", { mode: "number" }).notNull(),
    respawnAt: bigint("respawn_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    operationUnique: uniqueIndex(
      "gathering_resource_states_operation_unique",
    ).on(table.operationId),
    respawnIdx: index("idx_gathering_resource_states_respawn").on(
      table.respawnAt,
    ),
  }),
);

/**
 * Durable gathering edges captured inside the same transaction as reward
 * custody. One row records that a specific active quest incarnation existed
 * when the reward committed; QuestSystem later resolves it exactly once.
 */
export const questGatheringProgressReceipts = pgTable(
  "quest_gathering_progress_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operationsLog.id, { onDelete: "restrict" }),
    playerId: text("player_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("quest_id").notNull(),
    questStartedAt: bigint("quest_started_at", { mode: "number" }).notNull(),
    capturedStage: text("captured_stage").notNull(),
    rewardItemId: text("reward_item_id").notNull(),
    rewardQuantity: integer("reward_quantity").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    resolution: text("resolution"),
    resultingStage: text("resulting_stage"),
    resultingProgress: jsonb("resulting_progress"),
  },
  (table) => ({
    operationQuestUnique: uniqueIndex(
      "quest_gathering_progress_receipts_operation_quest_unique",
    ).on(table.operationId, table.questId),
    pendingPlayerIdx: index(
      "idx_quest_gathering_progress_receipts_pending_player",
    ).on(table.playerId, table.resolvedAt, table.createdAt, table.id),
    questIncarnationIdx: index(
      "idx_quest_gathering_progress_receipts_incarnation",
    ).on(table.playerId, table.questId, table.questStartedAt),
  }),
);

/** Durable interact-stage edges captured with atomic processing custody. */
export const questProcessingProgressReceipts = pgTable(
  "quest_processing_progress_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operationsLog.id, { onDelete: "restrict" }),
    playerId: text("player_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("quest_id").notNull(),
    questStartedAt: bigint("quest_started_at", { mode: "number" }).notNull(),
    capturedStage: text("captured_stage").notNull(),
    targetId: text("target_id").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    resolution: text("resolution"),
    resultingStage: text("resulting_stage"),
    resultingProgress: jsonb("resulting_progress"),
  },
  (table) => ({
    operationQuestTargetUnique: uniqueIndex(
      "quest_processing_progress_receipts_operation_quest_target_unique",
    ).on(table.operationId, table.questId, table.targetId),
    pendingPlayerIdx: index(
      "idx_quest_processing_progress_receipts_pending_player",
    ).on(table.playerId, table.resolvedAt, table.createdAt, table.id),
    questIncarnationIdx: index(
      "idx_quest_processing_progress_receipts_incarnation",
    ).on(table.playerId, table.questId, table.questStartedAt),
  }),
);

/** Durable kill edges captured with authenticated mob-loot custody. */
export const questKillProgressReceipts = pgTable(
  "quest_kill_progress_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operationsLog.id, { onDelete: "restrict" }),
    playerId: text("player_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("quest_id").notNull(),
    questStartedAt: bigint("quest_started_at", { mode: "number" }).notNull(),
    capturedStage: text("captured_stage").notNull(),
    mobId: text("mob_id").notNull(),
    mobType: text("mob_type").notNull(),
    quantity: integer("quantity").notNull().default(1),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    resolution: text("resolution"),
    resultingStage: text("resulting_stage"),
    resultingProgress: jsonb("resulting_progress"),
  },
  (table) => ({
    operationQuestUnique: uniqueIndex(
      "quest_kill_progress_receipts_operation_quest_unique",
    ).on(table.operationId, table.questId),
    pendingPlayerIdx: index(
      "idx_quest_kill_progress_receipts_pending_player",
    ).on(table.playerId, table.resolvedAt, table.createdAt, table.id),
    questIncarnationIdx: index(
      "idx_quest_kill_progress_receipts_incarnation",
    ).on(table.playerId, table.questId, table.questStartedAt),
  }),
);

/**
 * Active Firemaking world effects. Each row is created in the same database
 * transaction as its processing receipt, so a committed log debit can never
 * lose the corresponding fire when a server process restarts.
 */
export const processingActiveFires = pgTable(
  "processing_active_fires",
  {
    fireId: text("fire_id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operationsLog.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    positionX: doublePrecision("position_x").notNull(),
    positionY: doublePrecision("position_y").notNull(),
    positionZ: doublePrecision("position_z").notNull(),
    tileX: integer("tile_x").notNull(),
    tileZ: integer("tile_z").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    extinguishedAt: bigint("extinguished_at", { mode: "number" }),
  },
  (table) => ({
    operationUnique: uniqueIndex("processing_active_fires_operation_unique").on(
      table.operationId,
    ),
    activeExpiryIdx: index("idx_processing_active_fires_expiry").on(
      table.extinguishedAt,
      table.expiresAt,
    ),
    activeTileIdx: index("idx_processing_active_fires_tile").on(
      table.tileX,
      table.tileZ,
      table.extinguishedAt,
      table.expiresAt,
    ),
    oneActiveFirePerTile: uniqueIndex(
      "processing_active_fires_active_tile_unique",
    )
      .on(table.tileX, table.tileZ)
      .where(sql`${table.extinguishedAt} IS NULL`),
    activePlayerIdx: index("idx_processing_active_fires_player").on(
      table.playerId,
      table.extinguishedAt,
      table.expiresAt,
    ),
  }),
);

/**
 * ============================================================================
 * TABLE RELATIONS
 * ============================================================================
 *
 * Drizzle relations define how tables are connected for type-safe joins.
 * These don't create database constraints - they're TypeScript-only for queries.
 *
 * Relationship structure:
 * - characters → inventory (one-to-many)
 * - characters → equipment (one-to-many)
 * - characters → sessions (one-to-many)
 * - characters → chunkActivities (one-to-many)
 *
 * All child tables (inventory, equipment, etc.) have many-to-one back to characters.
 */

export const charactersRelations = relations(characters, ({ many }) => ({
  inventory: many(inventory),
  equipment: many(equipment),
  bankStorage: many(bankStorage),
  bankTabs: many(bankTabs),
  bankPlaceholders: many(bankPlaceholders),
  actionBars: many(actionBarStorage),
  sessions: many(playerSessions),
  chunkActivities: many(chunkActivity),
  npcKills: many(npcKills),
  deaths: many(playerDeaths),
  agentMappings: many(agentMappings),
  // Social system relations
  friendships: many(friendships, { relationName: "playerFriendships" }),
  friendOf: many(friendships, { relationName: "friendOf" }),
  sentFriendRequests: many(friendRequests, {
    relationName: "sentFriendRequests",
  }),
  receivedFriendRequests: many(friendRequests, {
    relationName: "receivedFriendRequests",
  }),
  ignoreList: many(ignoreList, { relationName: "playerIgnoreList" }),
  ignoredBy: many(ignoreList, { relationName: "ignoredBy" }),
}));

export const agentMappingsRelations = relations(agentMappings, ({ one }) => ({
  user: one(users, {
    fields: [agentMappings.accountId],
    references: [users.id],
  }),
  character: one(characters, {
    fields: [agentMappings.characterId],
    references: [characters.id],
  }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  character: one(characters, {
    fields: [inventory.playerId],
    references: [characters.id],
  }),
}));

export const equipmentRelations = relations(equipment, ({ one }) => ({
  character: one(characters, {
    fields: [equipment.playerId],
    references: [characters.id],
  }),
}));

export const bankStorageRelations = relations(bankStorage, ({ one }) => ({
  character: one(characters, {
    fields: [bankStorage.playerId],
    references: [characters.id],
  }),
}));

export const bankTabsRelations = relations(bankTabs, ({ one }) => ({
  character: one(characters, {
    fields: [bankTabs.playerId],
    references: [characters.id],
  }),
}));

export const bankPlaceholdersRelations = relations(
  bankPlaceholders,
  ({ one }) => ({
    character: one(characters, {
      fields: [bankPlaceholders.playerId],
      references: [characters.id],
    }),
  }),
);

export const actionBarStorageRelations = relations(
  actionBarStorage,
  ({ one }) => ({
    character: one(characters, {
      fields: [actionBarStorage.playerId],
      references: [characters.id],
    }),
  }),
);

export const playerSessionsRelations = relations(playerSessions, ({ one }) => ({
  character: one(characters, {
    fields: [playerSessions.playerId],
    references: [characters.id],
  }),
}));

export const chunkActivityRelations = relations(chunkActivity, ({ one }) => ({
  character: one(characters, {
    fields: [chunkActivity.playerId],
    references: [characters.id],
  }),
}));

export const npcKillsRelations = relations(npcKills, ({ one }) => ({
  character: one(characters, {
    fields: [npcKills.playerId],
    references: [characters.id],
  }),
}));

export const playerDeathsRelations = relations(playerDeaths, ({ one }) => ({
  character: one(characters, {
    fields: [playerDeaths.playerId],
    references: [characters.id],
  }),
}));

export const layoutPresetsRelations = relations(layoutPresets, ({ one }) => ({
  user: one(users, {
    fields: [layoutPresets.userId],
    references: [users.id],
  }),
}));

export const userBansRelations = relations(userBans, ({ one }) => ({
  bannedUser: one(users, {
    fields: [userBans.bannedUserId],
    references: [users.id],
  }),
  bannedByUser: one(users, {
    fields: [userBans.bannedByUserId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  layoutPresets: many(layoutPresets),
}));

// ============================================================================
// QUEST AUDIT TABLES
// ============================================================================

/**
 * Quest Audit Log Table - Tracks all quest state changes for security auditing
 *
 * Provides an immutable audit trail for quest actions to detect exploits.
 * Each row represents a single quest action (start, progress, complete).
 *
 * Key columns:
 * - `id` - Auto-incrementing primary key
 * - `playerId` - References characters.id (who performed the action)
 * - `questId` - Quest identifier from quests.json manifest
 * - `action` - Type of action ("started", "progressed", "completed")
 * - `questPointsAwarded` - Points awarded (for completed actions)
 * - `stageId` - Current stage at time of action
 * - `stageProgress` - Progress snapshot at time of action (JSON)
 * - `timestamp` - When the action occurred (Unix ms)
 * - `metadata` - Additional context (IP, session, etc.)
 *
 * Design notes:
 * - Immutable log - no updates or deletes in normal operation
 * - Used for security auditing and exploit detection
 * - Indexed for efficient queries by player and quest
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const questAuditLog = pgTable(
  "quest_audit_log",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("questId").notNull(),
    action: text("action").notNull(), // "started", "progressed", "completed"
    questPointsAwarded: integer("questPointsAwarded").default(0),
    stageId: text("stageId"),
    stageProgress: jsonb("stageProgress").default({}),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").default({}),
  },
  (table) => ({
    playerIdx: index("idx_quest_audit_log_player").on(table.playerId),
    questIdx: index("idx_quest_audit_log_quest").on(table.questId),
    playerQuestIdx: index("idx_quest_audit_log_player_quest").on(
      table.playerId,
      table.questId,
    ),
    timestampIdx: index("idx_quest_audit_log_timestamp").on(table.timestamp),
    actionIdx: index("idx_quest_audit_log_action").on(table.action),
  }),
);

/**
 * Quest Audit Log Relations
 */
export const questAuditLogRelations = relations(questAuditLog, ({ one }) => ({
  character: one(characters, {
    fields: [questAuditLog.playerId],
    references: [characters.id],
  }),
}));

// ============================================================================
// ADMIN PANEL TABLES
// ============================================================================

/**
 * Activity Log Table - Tracks all player actions for admin auditing
 *
 * Stores a comprehensive log of player activities including:
 * - Item pickup/drop
 * - Equipment changes
 * - NPC kills
 * - Bank transactions
 * - Store transactions
 * - Trading
 *
 * Key columns:
 * - `id` - Auto-incrementing primary key
 * - `playerId` - References characters.id (who performed the action)
 * - `eventType` - Type of event (e.g., "ITEM_PICKUP", "NPC_DIED")
 * - `action` - Human-readable action (e.g., "picked_up", "killed")
 * - `entityType` - Type of entity involved (e.g., "item", "npc", "player")
 * - `entityId` - ID of the entity involved
 * - `details` - JSON object with event-specific data
 * - `position` - JSON object {x, y, z} of where action occurred
 * - `timestamp` - When the action occurred (Unix ms)
 *
 * Design notes:
 * - 90-day retention policy (cleanup via maintenance job)
 * - Indexed for efficient queries by player, event type, and time range
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const activityLog = pgTable(
  "activity_log",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    eventType: text("eventType").notNull(),
    action: text("action").notNull(),
    entityType: text("entityType"),
    entityId: text("entityId"),
    details: jsonb("details")
      .default(sql`'{}'::jsonb`)
      .notNull(),
    position: jsonb("position"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => ({
    playerIdx: index("idx_activity_log_player").on(table.playerId),
    timestampIdx: index("idx_activity_log_timestamp").on(table.timestamp),
    playerTimestampIdx: index("idx_activity_log_player_timestamp").on(
      table.playerId,
      table.timestamp,
    ),
    eventTypeIdx: index("idx_activity_log_event_type").on(table.eventType),
    playerEventTypeIdx: index("idx_activity_log_player_event_type").on(
      table.playerId,
      table.eventType,
      table.timestamp,
    ),
  }),
);

/**
 * Trades Table - Records all completed trades between players
 *
 * Stores a history of all player-to-player trades including:
 * - Who initiated the trade
 * - Who received the trade
 * - What items were exchanged
 * - What coins were exchanged
 * - Trade status (completed, cancelled, declined)
 *
 * Key columns:
 * - `id` - Auto-incrementing primary key
 * - `initiatorId` - References characters.id (who started the trade)
 * - `receiverId` - References characters.id (who accepted the trade)
 * - `status` - Trade outcome ("completed", "cancelled", "declined")
 * - `initiatorItems` - JSON array of items given by initiator
 * - `receiverItems` - JSON array of items given by receiver
 * - `initiatorCoins` - Coins given by initiator
 * - `receiverCoins` - Coins given by receiver
 * - `timestamp` - When trade completed (Unix ms)
 *
 * Design notes:
 * - SET NULL on delete preserves trade history even if player is deleted
 * - 90-day retention policy (cleanup via maintenance job)
 * - Indexed for efficient queries by player and time range
 */
export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    initiatorId: text("initiatorId").references(() => characters.id, {
      onDelete: "set null",
    }),
    receiverId: text("receiverId").references(() => characters.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(), // "completed", "cancelled", "declined"
    initiatorItems: jsonb("initiatorItems")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    receiverItems: jsonb("receiverItems")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    initiatorCoins: integer("initiatorCoins").default(0).notNull(),
    receiverCoins: integer("receiverCoins").default(0).notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => ({
    initiatorIdx: index("idx_trades_initiator").on(table.initiatorId),
    receiverIdx: index("idx_trades_receiver").on(table.receiverId),
    timestampIdx: index("idx_trades_timestamp").on(table.timestamp),
    initiatorTimestampIdx: index("idx_trades_initiator_timestamp").on(
      table.initiatorId,
      table.timestamp,
    ),
    receiverTimestampIdx: index("idx_trades_receiver_timestamp").on(
      table.receiverId,
      table.timestamp,
    ),
  }),
);

/**
 * Activity Log Relations
 */
export const activityLogRelations = relations(activityLog, ({ one }) => ({
  character: one(characters, {
    fields: [activityLog.playerId],
    references: [characters.id],
  }),
}));

/**
 * Trades Relations
 */
export const tradesRelations = relations(trades, ({ one }) => ({
  initiator: one(characters, {
    fields: [trades.initiatorId],
    references: [characters.id],
    relationName: "tradeInitiator",
  }),
  receiver: one(characters, {
    fields: [trades.receiverId],
    references: [characters.id],
    relationName: "tradeReceiver",
  }),
}));

/**
 * Update characters relations to include activity logs and trades
 */
export const charactersActivityRelations = relations(
  characters,
  ({ many }) => ({
    activityLogs: many(activityLog),
    initiatedTrades: many(trades, { relationName: "tradeInitiator" }),
    receivedTrades: many(trades, { relationName: "tradeReceiver" }),
  }),
);

// ============================================================================
// ANTI-CHEAT VIOLATIONS TABLE
// ============================================================================

/**
 * Anti-Cheat Violations Table - Persistent record of combat violations
 *
 * Stores violations detected by the CombatAntiCheat system for historical
 * analysis, admin review, and pattern detection across server restarts.
 *
 * Key columns:
 * - `playerId` - References characters.id (who committed the violation)
 * - `violationType` - Type of violation (e.g., "out_of_range_attack")
 * - `severity` - Severity level ("MINOR", "MODERATE", "MAJOR", "CRITICAL")
 * - `details` - Human-readable violation description
 * - `score` - Weighted score at time of violation
 * - `targetId` - Target entity ID (if applicable)
 * - `gameTick` - Game tick when violation occurred
 * - `actionTaken` - Action taken (e.g., "kick", "ban", or null)
 * - `timestamp` - When the violation occurred (Unix ms)
 *
 * Design notes:
 * - Flushed periodically from in-memory CombatAntiCheat buffer (every save cycle)
 * - Indexed for efficient admin queries by player, severity, and time range
 * - CASCADE DELETE ensures cleanup when character is deleted
 * - Used by /admin/anticheat/history endpoint for violation investigation
 */
export const antiCheatViolations = pgTable(
  "anti_cheat_violations",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    violationType: text("violationType").notNull(),
    severity: text("severity").notNull(),
    details: text("details").notNull(),
    targetId: text("targetId"),
    gameTick: integer("gameTick"),
    score: integer("score").default(0).notNull(),
    actionTaken: text("actionTaken"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => ({
    playerIdx: index("idx_anti_cheat_violations_player").on(table.playerId),
    timestampIdx: index("idx_anti_cheat_violations_timestamp").on(
      table.timestamp,
    ),
    severityIdx: index("idx_anti_cheat_violations_severity").on(table.severity),
    playerTimestampIdx: index("idx_anti_cheat_violations_player_timestamp").on(
      table.playerId,
      table.timestamp,
    ),
  }),
);

/**
 * Anti-Cheat Violations Relations
 */
export const antiCheatViolationsRelations = relations(
  antiCheatViolations,
  ({ one }) => ({
    character: one(characters, {
      fields: [antiCheatViolations.playerId],
      references: [characters.id],
    }),
  }),
);

// ============================================================================
// DUEL SETTLEMENT TABLE
// ============================================================================

/**
 * Duel Settlements Table - Idempotency guard for duel stake transfers
 *
 * Ensures each duel's stake transfer executes exactly once, surviving server
 * restarts. The settlement row is inserted inside the same DB transaction as
 * the inventory mutations, so either both commit or neither does.
 *
 * Key columns:
 * - `duelId` - Unique duel identifier (primary key, prevents double-settlement)
 * - `winnerId` - Player who won the duel
 * - `loserId` - Player who lost the duel
 * - `settledAt` - When the settlement transaction committed (Unix ms)
 * - `stakesTransferred` - Number of item stacks transferred
 *
 * Design notes:
 * - Primary key on duelId is the idempotency guard — INSERT fails on duplicate
 * - 90-day retention policy (cleanup via maintenance job, same as trades)
 * - Indexed on winnerId/loserId for player history queries
 */
export const duelSettlements = pgTable(
  "duel_settlements",
  {
    duelId: text("duelId").primaryKey(),
    winnerId: text("winnerId")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    loserId: text("loserId")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    settledAt: bigint("settledAt", { mode: "number" }).notNull(),
    stakesTransferred: integer("stakesTransferred").default(0).notNull(),
  },
  (table) => ({
    winnerIdx: index("idx_duel_settlements_winner").on(table.winnerId),
    loserIdx: index("idx_duel_settlements_loser").on(table.loserId),
    settledAtIdx: index("idx_duel_settlements_settled_at").on(table.settledAt),
  }),
);

// ============================================================================
// COMBAT STATS + ONCHAIN OUTBOX TABLES
// ============================================================================

/**
 * Player Combat Stats - canonical per-player combat counters in PostgreSQL.
 *
 * Covers PvP kills, non-duel deaths (split into PvP vs PvE), and duel W/L.
 * Duel deaths are intentionally excluded from totalDeaths and death splits.
 */
export const playerCombatStats = pgTable(
  "player_combat_stats",
  {
    playerId: text("playerId")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    totalPlayerKills: integer("totalPlayerKills").notNull().default(0),
    totalDeaths: integer("totalDeaths").notNull().default(0),
    totalPvpDeaths: integer("totalPvpDeaths").notNull().default(0),
    totalPveDeaths: integer("totalPveDeaths").notNull().default(0),
    totalDuelWins: integer("totalDuelWins").notNull().default(0),
    totalDuelLosses: integer("totalDuelLosses").notNull().default(0),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    updatedAt: bigint("updatedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    updatedAtIdx: index("idx_player_combat_stats_updated_at").on(
      table.updatedAt,
    ),
    killsIdx: index("idx_player_combat_stats_kills").on(table.totalPlayerKills),
    deathsIdx: index("idx_player_combat_stats_deaths").on(table.totalDeaths),
    duelWinsIdx: index("idx_player_combat_stats_duel_wins").on(
      table.totalDuelWins,
    ),
  }),
);

/**
 * Combat Stat Events - durable idempotency keys for combat stat mutations.
 *
 * Protects against duplicate handling when the same world event is observed
 * multiple times (for example duplicate ENTITY_DEATH emissions in one tick).
 */
export const combatStatEvents = pgTable(
  "combat_stat_events",
  {
    eventKey: text("eventKey").primaryKey(),
    eventType: text("eventType").notNull(), // NON_DUEL_DEATH | DUEL_COMPLETED
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    secondaryPlayerId: text("secondaryPlayerId").references(
      () => characters.id,
      {
        onDelete: "set null",
      },
    ),
    classification: text("classification"), // PVP | PVE
    duelId: text("duelId"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    eventTypeIdx: index("idx_combat_stat_events_type").on(table.eventType),
    playerIdx: index("idx_combat_stat_events_player").on(table.playerId),
    secondaryIdx: index("idx_combat_stat_events_secondary").on(
      table.secondaryPlayerId,
    ),
    duelIdx: index("idx_combat_stat_events_duel").on(table.duelId),
    createdIdx: index("idx_combat_stat_events_created").on(table.createdAt),
  }),
);

/**
 * Onchain Outbox - strong transactional outbox for combat stat writes.
 *
 * Rows are produced in the same DB transaction as stat updates, then
 * asynchronously drained by the backend writer in MODE=web3.
 */
export const onchainOutbox = pgTable(
  "onchain_outbox",
  {
    id: serial("id").primaryKey(),
    stream: text("stream").notNull().default("combat_stats"),
    eventType: text("eventType").notNull(), // PLAYER_STATS_SNAPSHOT
    dedupeKey: text("dedupeKey").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | retry | sent | dead
    attemptCount: integer("attemptCount").notNull().default(0),
    nextAttemptAt: bigint("nextAttemptAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    lockedBy: text("lockedBy"),
    lockedAt: bigint("lockedAt", { mode: "number" }),
    lastError: text("lastError"),
    sentAt: bigint("sentAt", { mode: "number" }),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    updatedAt: bigint("updatedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("uidx_onchain_outbox_dedupe").on(table.dedupeKey),
    statusNextIdx: index("idx_onchain_outbox_status_next_attempt").on(
      table.status,
      table.nextAttemptAt,
    ),
    lockedIdx: index("idx_onchain_outbox_locked_at").on(table.lockedAt),
    streamIdx: index("idx_onchain_outbox_stream").on(table.stream),
  }),
);

/**
 * Read-only archive of the retired in-server betting integration.
 *
 * Hyperia owns duel truth only. Hyperbet owns native-SOL market and accounting
 * state. The archive preserves historical rows through the retirement migration
 * without keeping obsolete market, token, fee-share, or staking tables active.
 */
export const retiredArenaIntegrationRecords = pgTable(
  "retired_arena_integration_records",
  {
    id: serial("id").primaryKey(),
    sourceTable: text("source_table").notNull(),
    recordFingerprint: text("record_fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    archivedAt: bigint("archived_at", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    sourceIdx: index("idx_retired_arena_integration_source").on(
      table.sourceTable,
    ),
    fingerprintIdx: uniqueIndex(
      "uidx_retired_arena_integration_fingerprint",
    ).on(table.sourceTable, table.recordFingerprint),
  }),
);

// ============================================================================
// SOCIAL/FRIEND SYSTEM TABLES
// ============================================================================

/**
 * Friendships Table - Player friend relationships
 *
 * Stores bidirectional friend relationships. When two players become friends,
 * TWO rows are created (one for each direction) to enable efficient lookups.
 *
 * Key columns:
 * - `playerId` - The player who owns this friend entry
 * - `friendId` - The friend's player ID
 * - `createdAt` - When the friendship was established
 * - `note` - Optional nickname/note for the friend
 *
 * Design notes:
 * - Bidirectional: A friendship between A and B creates rows (A, B) and (B, A)
 * - Unique constraint prevents duplicate friendships
 * - Indexed on both playerId and friendId for fast lookups
 * - CASCADE DELETE ensures cleanup when character is deleted
 * - Max 99 friends per player (enforced in application logic)
 */
export const friendships = pgTable(
  "friendships",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    friendId: text("friendId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    note: text("note"), // Optional friend nickname
  },
  (table) => ({
    uniqueFriendship: unique().on(table.playerId, table.friendId),
    playerIdx: index("idx_friendships_player").on(table.playerId),
    friendIdx: index("idx_friendships_friend").on(table.friendId),
  }),
);

/**
 * Friend Requests Table - Pending friend requests
 *
 * Stores friend requests that have been sent but not yet accepted/declined.
 * Requests automatically expire after 7 days (handled in application logic).
 *
 * Key columns:
 * - `id` - Unique request UUID
 * - `fromPlayerId` - Player who sent the request
 * - `toPlayerId` - Player who received the request
 * - `createdAt` - When the request was sent
 *
 * Design notes:
 * - Only pending requests are stored; accepted/declined are deleted
 * - Unique constraint prevents duplicate requests
 * - Indexed for fast lookup by recipient (most common query)
 * - CASCADE DELETE ensures cleanup when character is deleted
 */
export const friendRequests = pgTable(
  "friend_requests",
  {
    id: text("id").primaryKey(), // UUID
    fromPlayerId: text("fromPlayerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    toPlayerId: text("toPlayerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (table) => ({
    uniqueRequest: unique().on(table.fromPlayerId, table.toPlayerId),
    toPlayerIdx: index("idx_friend_requests_to").on(table.toPlayerId),
    fromPlayerIdx: index("idx_friend_requests_from").on(table.fromPlayerId),
    createdAtIdx: index("idx_friend_requests_created").on(table.createdAt),
  }),
);

/**
 * Ignore List Table - Blocked players
 *
 * Stores players that a user has blocked/ignored.
 * Ignored players cannot send private messages or friend requests.
 *
 * Key columns:
 * - `playerId` - The player who is ignoring
 * - `ignoredPlayerId` - The player being ignored
 * - `createdAt` - When the ignore was added
 *
 * Design notes:
 * - Unidirectional: A ignoring B doesn't mean B ignores A
 * - Unique constraint prevents duplicate entries
 * - Indexed on playerId for fast ignore list lookups
 * - CASCADE DELETE ensures cleanup when character is deleted
 * - Max 99 ignored players per player (enforced in application logic)
 */
export const ignoreList = pgTable(
  "ignore_list",
  {
    id: serial("id").primaryKey(),
    playerId: text("playerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    ignoredPlayerId: text("ignoredPlayerId")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    uniqueIgnore: unique().on(table.playerId, table.ignoredPlayerId),
    playerIdx: index("idx_ignore_list_player").on(table.playerId),
  }),
);

/**
 * Friendships Relations
 */
export const friendshipsRelations = relations(friendships, ({ one }) => ({
  player: one(characters, {
    fields: [friendships.playerId],
    references: [characters.id],
    relationName: "playerFriendships",
  }),
  friend: one(characters, {
    fields: [friendships.friendId],
    references: [characters.id],
    relationName: "friendOf",
  }),
}));

/**
 * Friend Requests Relations
 */
export const friendRequestsRelations = relations(friendRequests, ({ one }) => ({
  fromPlayer: one(characters, {
    fields: [friendRequests.fromPlayerId],
    references: [characters.id],
    relationName: "sentFriendRequests",
  }),
  toPlayer: one(characters, {
    fields: [friendRequests.toPlayerId],
    references: [characters.id],
    relationName: "receivedFriendRequests",
  }),
}));

/**
 * Ignore List Relations
 */
export const ignoreListRelations = relations(ignoreList, ({ one }) => ({
  player: one(characters, {
    fields: [ignoreList.playerId],
    references: [characters.id],
    relationName: "playerIgnoreList",
  }),
  ignoredPlayer: one(characters, {
    fields: [ignoreList.ignoredPlayerId],
    references: [characters.id],
    relationName: "ignoredBy",
  }),
}));

// ============================================================================
// FAILED TRANSACTION RECOVERY TABLE
// ============================================================================

/**
 * Failed Transactions Table - Recovery queue for failed blockchain writes
 *
 * Persists failed MUD system calls for later recovery and dead-letter handling.
 * Used by BatchWriter to ensure no data is lost on transaction failures.
 *
 * Key columns:
 * - `dedupeKey` - Unique identifier for the call (prevents duplicates)
 * - `callData` - The encoded transaction data (hex)
 * - `description` - Human-readable description
 * - `status` - "pending" | "dead_letter"
 * - `attemptCount` - Number of retry attempts
 * - `lastError` - Most recent error message
 * - `queuedAt` - When the call was originally queued
 * - `failedAt` - When the call was marked as failed
 *
 * Design notes:
 * - Primary key on dedupeKey ensures idempotent persistence
 * - Dead letter transactions are kept for manual review/replay
 * - Pending transactions are loaded on startup for recovery
 */
export const failedTransactions = pgTable(
  "failed_transactions",
  {
    dedupeKey: text("dedupeKey").primaryKey(),
    callData: text("callData").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("pending"), // "pending" | "dead_letter"
    attemptCount: integer("attemptCount").notNull().default(0),
    lastError: text("lastError"),
    queuedAt: bigint("queuedAt", { mode: "number" }).notNull(),
    failedAt: bigint("failedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    statusIdx: index("idx_failed_transactions_status").on(table.status),
    failedAtIdx: index("idx_failed_transactions_failed_at").on(table.failedAt),
  }),
);

// ============================================================================
// AGENT DUEL STATS TABLE
// ============================================================================

/**
 * Agent Duel Stats - AI agent performance tracking for streaming mode
 *
 * Tracks performance metrics for AI agents in autonomous duel streaming.
 * This enables leaderboards, model comparison, and betting market insights.
 *
 * Key columns:
 * - `characterId` - References characters.id (agent character)
 * - `agentName` - Display name of the agent
 * - `provider` - AI provider (e.g., "openai", "anthropic")
 * - `model` - AI model identifier (e.g., "gpt-4", "claude-3-opus")
 * - `wins` - Total duel wins
 * - `losses` - Total duel losses
 * - `draws` - Total draws (timeouts, mutual kills)
 * - `totalDamageDealt` - Cumulative damage dealt across all duels
 * - `totalDamageTaken` - Cumulative damage taken across all duels
 * - `killStreak` - Best kill streak achieved
 * - `currentStreak` - Current consecutive win streak
 * - `lastDuelAt` - When agent last participated in a duel
 *
 * Design notes:
 * - Indexed on wins for leaderboard queries
 * - Win rate computed as wins / (wins + losses)
 * - Used by StreamingDuelScheduler for agent selection and stats display
 */
export const agentDuelStats = pgTable(
  "agent_duel_stats",
  {
    characterId: text("characterId")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    agentName: text("agentName").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    totalDamageDealt: integer("totalDamageDealt").notNull().default(0),
    totalDamageTaken: integer("totalDamageTaken").notNull().default(0),
    killStreak: integer("killStreak").notNull().default(0),
    currentStreak: integer("currentStreak").notNull().default(0),
    lastDuelAt: bigint("lastDuelAt", { mode: "number" }),
    createdAt: bigint("createdAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
    updatedAt: bigint("updatedAt", { mode: "number" })
      .notNull()
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`),
  },
  (table) => ({
    winsIdx: index("idx_agent_duel_stats_wins").on(table.wins),
    providerIdx: index("idx_agent_duel_stats_provider").on(table.provider),
    modelIdx: index("idx_agent_duel_stats_model").on(table.model),
    lastDuelIdx: index("idx_agent_duel_stats_last_duel").on(table.lastDuelAt),
  }),
);

/**
 * Agent Duel Stats Relations
 */
export const agentDuelStatsRelations = relations(agentDuelStats, ({ one }) => ({
  character: one(characters, {
    fields: [agentDuelStats.characterId],
    references: [characters.id],
  }),
}));

/**
 * Streaming Duel History - compatibility cache of duel outcomes.
 *
 * Written best-effort by MatchmakingManager after each cycle resolves. Modern
 * persisted-duel restart and opponent-history truth is reconstructed from the
 * immutable competitive snapshot terminal and exact public damage receipts;
 * this table remains the fallback for pre-snapshot and diagnostic history.
 */
export const streamingDuelHistory = pgTable(
  "streaming_duel_history",
  {
    id: serial("id").primaryKey(),
    cycleId: text("cycleId").notNull(),
    duelId: text("duelId"),
    finishedAt: bigint("finishedAt", { mode: "number" }).notNull(),
    outcome: text("outcome").notNull().default("win"),
    agent1Id: text("agent1Id"),
    agent1Name: text("agent1Name"),
    agent1OpeningStyle: text("agent1OpeningStyle"),
    agent2Id: text("agent2Id"),
    agent2Name: text("agent2Name"),
    agent2OpeningStyle: text("agent2OpeningStyle"),
    winnerId: text("winnerId"),
    winnerName: text("winnerName"),
    loserId: text("loserId"),
    loserName: text("loserName"),
    winReason: text("winReason"),
    cancellationReason: text("cancellationReason"),
    damageAgent1: integer("damageAgent1").notNull().default(0),
    damageAgent2: integer("damageAgent2").notNull().default(0),
    damageWinner: integer("damageWinner").default(0),
    damageLoser: integer("damageLoser").default(0),
  },
  (table) => ({
    finishedAtIdx: index("idx_streaming_duel_history_finished").on(
      table.finishedAt,
    ),
    winnerIdx: index("idx_streaming_duel_history_winner").on(table.winnerId),
    loserIdx: index("idx_streaming_duel_history_loser").on(table.loserId),
  }),
);

/**
 * Agent Thoughts Table - Persistent agent decision log
 *
 * Stores every LLM/scripted decision an agent makes so that thought history
 * survives server restarts. The in-memory `ServerNetwork.agentThoughts` map
 * serves as a hot cache; this table is the durable backing store.
 */
export const agentThoughts = pgTable(
  "agent_thoughts",
  {
    id: serial("id").primaryKey(),
    characterId: text("character_id").notNull(),
    type: text("type").notNull(), // "thinking" | "action" | "observation"
    content: text("content").notNull(),
    decisionPath: text("decision_path"), // "llm" | "scripted" | null
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => ({
    characterTimestampIdx: index("idx_agent_thoughts_char_ts").on(
      table.characterId,
      table.timestamp,
    ),
  }),
);
