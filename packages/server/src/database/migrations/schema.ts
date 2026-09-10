import {
  pgTable,
  text,
  timestamp,
  integer,
  doublePrecision,
  real,
  bigint,
  bigserial,
  jsonb,
  index,
  unique,
  foreignKey,
  serial,
  boolean,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const config = pgTable("config", {
  key: text().primaryKey().notNull(),
  value: text(),
});

export const entities = pgTable("entities", {
  id: text().primaryKey().notNull(),
  data: text().notNull(),
  createdAt: timestamp({ mode: "string" }).defaultNow(),
  updatedAt: timestamp({ mode: "string" }).defaultNow(),
});

export const items = pgTable("items", {
  id: integer().primaryKey().notNull(),
  name: text().notNull(),
  type: text().notNull(),
  description: text(),
  value: integer().default(0),
  weight: real().default(0),
  stackable: integer().default(0),
  tradeable: integer().default(1),
  attackLevel: integer(),
  strengthLevel: integer(),
  defenseLevel: integer(),
  rangedLevel: integer(),
  attackBonus: integer().default(0),
  strengthBonus: integer().default(0),
  defenseBonus: integer().default(0),
  rangedBonus: integer().default(0),
  heals: integer(),
});

export const storage = pgTable("storage", {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  updatedAt: bigint({ mode: "number" }).default(
    sql`((EXTRACT(epoch FROM now()) * (1000)`,
  ),
});

export const users = pgTable(
  "users",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    roles: text().notNull(),
    createdAt: text().notNull(),
    avatar: text(),
    privyUserId: text(),
    farcasterFid: text(),
    wallet: text(),
  },
  (table) => [
    index("idx_users_farcaster").using(
      "btree",
      table.farcasterFid.asc().nullsLast().op("text_ops"),
    ),
    index("idx_users_name").using(
      "btree",
      table.name.asc().nullsLast().op("text_ops"),
    ),
    index("idx_users_privy").using(
      "btree",
      table.privyUserId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_users_wallet").using(
      "btree",
      table.wallet.asc().nullsLast().op("text_ops"),
    ),
    unique("users_privyUserId_unique").on(table.privyUserId),
  ],
);

export const worldChunks = pgTable(
  "world_chunks",
  {
    chunkX: integer().notNull(),
    chunkZ: integer().notNull(),
    data: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    lastActive: bigint({ mode: "number" }).default(
      sql`((EXTRACT(epoch FROM now()) * (1000)`,
    ),
    playerCount: integer().default(0),
    version: integer().default(1),
    needsReset: integer().default(0),
  },
  (table) => [
    unique("world_chunks_chunkX_chunkZ_unique").on(table.chunkX, table.chunkZ),
  ],
);

export const characters = pgTable(
  "characters",
  {
    id: text().primaryKey().notNull(),
    accountId: text().notNull(),
    name: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    createdAt: bigint({ mode: "number" }).default(
      sql`((EXTRACT(epoch FROM now()) * (1000)`,
    ),
    combatLevel: integer().default(3),
    attackLevel: integer().default(1),
    strengthLevel: integer().default(1),
    defenseLevel: integer().default(1),
    constitutionLevel: integer().default(10),
    rangedLevel: integer().default(1),
    prayerLevel: integer().default(1),
    woodcuttingLevel: integer().default(1),
    miningLevel: integer().default(1),
    fishingLevel: integer().default(1),
    firemakingLevel: integer().default(1),
    cookingLevel: integer().default(1),
    smithingLevel: integer().default(1),
    agilityLevel: integer().default(1),
    craftingLevel: integer().default(1),
    fletchingLevel: integer().default(1),
    runecraftingLevel: integer().default(1),
    attackXp: integer().default(0),
    strengthXp: integer().default(0),
    defenseXp: integer().default(0),
    constitutionXp: integer().default(1154),
    rangedXp: integer().default(0),
    prayerXp: integer().default(0),
    woodcuttingXp: doublePrecision().default(0).notNull(),
    miningXp: doublePrecision().default(0).notNull(),
    fishingXp: doublePrecision().default(0).notNull(),
    firemakingXp: doublePrecision().default(0).notNull(),
    cookingXp: doublePrecision().default(0).notNull(),
    smithingXp: doublePrecision().default(0).notNull(),
    agilityXp: integer().default(0),
    craftingXp: doublePrecision().default(0).notNull(),
    fletchingXp: doublePrecision().default(0).notNull(),
    runecraftingXp: doublePrecision().default(0).notNull(),
    prayerPoints: integer().default(1),
    prayerPointUnits: integer().default(1_000_000),
    prayerMaxPoints: integer().notNull().default(1),
    activePrayers: jsonb().default([]),
    processingConsumableUses: jsonb().notNull().default({}),
    health: integer().default(100),
    maxHealth: integer().default(100),
    coins: integer().default(0),
    positionX: real().default(0),
    positionY: real().default(10),
    positionZ: real().default(0),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    lastLogin: bigint({ mode: "number" }).default(0),
    avatar: text(),
    wallet: text(),
    isAgent: integer().default(0).notNull(),
  },
  (table) => [
    index("idx_characters_account").using(
      "btree",
      table.accountId.asc().nullsLast().op("text_ops"),
    ),
    index("idx_characters_is_agent").using(
      "btree",
      table.isAgent.asc().nullsLast().op("int4_ops"),
    ),
    index("idx_characters_wallet").using(
      "btree",
      table.wallet.asc().nullsLast().op("text_ops"),
    ),
  ],
);

export const boneBurialOperations = pgTable(
  "bone_burial_operations",
  {
    operationId: text("operation_id").primaryKey().notNull(),
    playerId: text("player_id").notNull(),
    itemId: text("item_id").notNull(),
    xpAmount: integer("xp_amount").notNull(),
    levelRequired: integer("level_required").notNull(),
    awardedXp: integer("awarded_xp").notNull(),
    operationCommittedXp: integer("operation_committed_xp").notNull(),
    committedLevel: integer("committed_level").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`)
      .notNull(),
  },
  (table) => [
    index("idx_bone_burial_operations_player_created").using(
      "btree",
      table.playerId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("int8_ops"),
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "bone_burial_operations_player_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const agentStoreOperations = pgTable(
  "agent_store_operations",
  {
    operationId: text("operation_id").primaryKey().notNull(),
    playerId: text("player_id").notNull(),
    action: text().notNull(),
    storeId: text("store_id").notNull(),
    itemId: text("item_id").notNull(),
    requestedQuantity: integer("requested_quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    totalValue: integer("total_value").notNull(),
    coinBalanceAfter: integer("coin_balance_after").notNull(),
    inventoryQuantityAfter: integer("inventory_quantity_after").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`)
      .notNull(),
  },
  (table) => [
    index("idx_agent_store_operations_player_created").using(
      "btree",
      table.playerId.asc().nullsLast().op("text_ops"),
      table.createdAt.asc().nullsLast().op("int8_ops"),
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "agent_store_operations_player_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const agentAutonomyCheckpoints = pgTable(
  "agent_autonomy_checkpoints",
  {
    characterId: text("character_id").primaryKey().notNull(),
    schemaVersion: integer("schema_version").default(3).notNull(),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    goal: jsonb("goal"),
    plan: jsonb("plan"),
    memories: jsonb("memories").default([]).notNull(),
    recentActionLog: jsonb("recent_action_log").default([]).notNull(),
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
  (table) => [
    index("idx_agent_autonomy_checkpoints_updated_at").using(
      "btree",
      table.updatedAt.asc().nullsLast().op("int8_ops"),
    ),
    foreignKey({
      columns: [table.characterId],
      foreignColumns: [characters.id],
      name: "agent_autonomy_checkpoints_character_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

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
  (table) => [
    uniqueIndex("uidx_agent_autonomy_progression_events_key").on(
      table.eventKey,
    ),
    uniqueIndex("uidx_agent_autonomy_progression_events_attempt_edge").on(
      table.attemptId,
      table.eventType,
    ),
    index("idx_agent_autonomy_progression_events_character_sequence").on(
      table.characterId,
      table.eventSequence,
    ),
    index("idx_agent_autonomy_progression_events_action_time").on(
      table.actionType,
      table.occurredAt,
    ),
    uniqueIndex("uidx_agent_autonomy_progression_events_terminal_checkpoint")
      .on(table.characterId, table.checkpointRevision)
      .where(sql`${table.eventType} = 'attempt_terminal'`),
  ],
);

export const agentAutonomyProgressionHeads = pgTable(
  "agent_autonomy_progression_heads",
  {
    characterId: text("character_id").primaryKey().notNull(),
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
  (table) => [
    uniqueIndex("uidx_agent_autonomy_progression_heads_open_attempt")
      .on(table.openAttemptId)
      .where(sql`${table.openAttemptId} IS NOT NULL`),
    foreignKey({
      columns: [table.characterId],
      foreignColumns: [characters.id],
      name: "agent_autonomy_progression_heads_character_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const agentAutonomyLifecycleEvents = pgTable(
  "agent_autonomy_lifecycle_events",
  {
    eventSequence: bigserial("event_sequence", {
      mode: "bigint",
    }).primaryKey(),
    eventKey: text("event_key").notNull(),
    characterId: text("character_id").notNull(),
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
  (table) => [
    uniqueIndex("uidx_agent_autonomy_lifecycle_events_key").on(table.eventKey),
    index("idx_agent_autonomy_lifecycle_events_character_sequence").on(
      table.characterId,
      table.eventSequence,
    ),
    index("idx_agent_autonomy_lifecycle_events_state_time").on(
      table.lifecycleState,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.characterId],
      foreignColumns: [characters.id],
      name: "agent_autonomy_lifecycle_events_character_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const agentAutonomyLifecycleHeads = pgTable(
  "agent_autonomy_lifecycle_heads",
  {
    characterId: text("character_id").primaryKey().notNull(),
    currentState: text("current_state").default("goal_selection").notNull(),
    currentGoalType: text("current_goal_type"),
    headRevision: bigint("head_revision", { mode: "number" })
      .default(0)
      .notNull(),
    updatedAt: bigint("updated_at", { mode: "number" })
      .default(sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`)
      .notNull(),
  },
  (table) => [
    index("idx_agent_autonomy_lifecycle_heads_state_updated").on(
      table.currentState,
      table.updatedAt,
    ),
    foreignKey({
      columns: [table.characterId],
      foreignColumns: [characters.id],
      name: "agent_autonomy_lifecycle_heads_character_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const chunkActivity = pgTable(
  "chunk_activity",
  {
    id: serial().primaryKey().notNull(),
    chunkX: integer().notNull(),
    chunkZ: integer().notNull(),
    playerId: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    entryTime: bigint({ mode: "number" }).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    exitTime: bigint({ mode: "number" }),
  },
  (table) => [
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "chunk_activity_playerId_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const equipment = pgTable(
  "equipment",
  {
    id: serial().primaryKey().notNull(),
    playerId: text().notNull(),
    slotType: text().notNull(),
    itemId: text(),
    quantity: integer().default(1),
  },
  (table) => [
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "equipment_playerId_characters_id_fk",
    }).onDelete("cascade"),
    unique("equipment_playerId_slotType_unique").on(
      table.playerId,
      table.slotType,
    ),
  ],
);

export const inventory = pgTable(
  "inventory",
  {
    id: serial().primaryKey().notNull(),
    playerId: text().notNull(),
    itemId: text().notNull(),
    quantity: integer().default(1),
    slotIndex: integer().default(sql`'-1'`),
    metadata: text(),
  },
  (table) => [
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "inventory_playerId_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const playerSessions = pgTable(
  "player_sessions",
  {
    id: text().primaryKey().notNull(),
    playerId: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    sessionStart: bigint({ mode: "number" }).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    sessionEnd: bigint({ mode: "number" }),
    playtimeMinutes: integer().default(0),
    reason: text(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    lastActivity: bigint({ mode: "number" }).default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "player_sessions_playerId_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const agentMappings = pgTable(
  "agent_mappings",
  {
    agentId: text("agent_id").primaryKey().notNull(),
    accountId: text("account_id").notNull(),
    characterId: text("character_id").notNull(),
    agentName: text("agent_name").notNull(),
    streamingDuelEnabled: boolean("streaming_duel_enabled")
      .default(false)
      .notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_agent_mappings_account").using(
      "btree",
      table.accountId.asc().nullsLast().op("text_ops"),
    ),
    uniqueIndex("idx_agent_mappings_character").using(
      "btree",
      table.characterId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [users.id],
      name: "agent_mappings_account_id_users_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.characterId],
      foreignColumns: [characters.id],
      name: "agent_mappings_character_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

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
    issuedAt: timestamp("issued_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "string",
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", {
      mode: "string",
      withTimezone: true,
    }),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
    lastFailureAt: timestamp("last_failure_at", {
      mode: "string",
      withTimezone: true,
    }),
    failureCode: text("failure_code"),
  },
  (table) => [
    index("idx_solana_agent_auth_wallet_active").using(
      "btree",
      table.walletHash.asc().nullsLast().op("text_ops"),
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    index("idx_solana_agent_auth_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    check(
      "solana_agent_auth_hash_lengths_check",
      sql`${table.walletHash} ~ '^[0-9a-f]{64}$' AND ${table.messageHash} ~ '^[0-9a-f]{64}$' AND ${table.nonceHash} ~ '^[0-9a-f]{64}$' AND ${table.configFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "solana_agent_auth_lifetime_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      "solana_agent_auth_attempts_check",
      sql`${table.failedAttempts} >= 0 AND ${table.failedAttempts} <= 5`,
    ),
    check(
      "solana_agent_auth_terminal_check",
      sql`NOT (${table.consumedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

export const agentCredentialSessions = pgTable(
  "agent_credential_sessions",
  {
    sessionId: text("session_id").primaryKey().notNull(),
    accountId: text("account_id").notNull(),
    characterId: text("character_id").notNull(),
    authMethod: text("auth_method").notNull(),
    issuedAt: timestamp("issued_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp("revoked_at", {
      mode: "string",
      withTimezone: true,
    }),
    revokedReason: text("revoked_reason"),
  },
  (table) => [
    uniqueIndex("idx_agent_credential_sessions_one_active")
      .using(
        "btree",
        table.accountId.asc().nullsLast().op("text_ops"),
        table.characterId.asc().nullsLast().op("text_ops"),
      )
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_agent_credential_sessions_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    check(
      "agent_credential_session_id_check",
      sql`${table.sessionId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "agent_credential_session_auth_method_check",
      sql`${table.authMethod} IN ('sol-wallet-signature-v1', 'owner-credential-v1', 'local-diagnostic-wallet-v1', 'server-managed-agent-v1')`,
    ),
    check(
      "agent_credential_session_lifetime_check",
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + INTERVAL '7 days'`,
    ),
    check(
      "agent_credential_session_revocation_check",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedAt} >= ${table.issuedAt} AND ${table.revokedReason} IN ('rotated', 'owner_revoked', 'security_revoked'))`,
    ),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [users.id],
      name: "agent_credential_sessions_account_id_users_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.characterId],
      foreignColumns: [characters.id],
      name: "agent_credential_sessions_character_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const distributedRateLimitBuckets = pgTable(
  "distributed_rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey().notNull(),
    scope: text("scope").notNull(),
    windowMs: integer("window_ms").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    requestCount: bigint("request_count", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index("idx_distributed_rate_limit_buckets_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    check(
      "distributed_rate_limit_bucket_key_check",
      sql`${table.bucketKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "distributed_rate_limit_scope_check",
      sql`${table.scope} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`,
    ),
    check(
      "distributed_rate_limit_window_check",
      sql`${table.windowMs} BETWEEN 1000 AND 3600000 AND ${table.expiresAt} = ${table.windowStartedAt} + (${table.windowMs} * INTERVAL '1 millisecond')`,
    ),
    check(
      "distributed_rate_limit_count_check",
      sql`${table.requestCount} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "distributed_rate_limit_updated_check",
      sql`${table.updatedAt} >= ${table.windowStartedAt} AND ${table.updatedAt} <= ${table.expiresAt}`,
    ),
  ],
);

export const characterTemplates = pgTable(
  "character_templates",
  {
    id: serial().primaryKey().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    emoji: text().notNull(),
    templateUrl: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    createdAt: bigint({ mode: "number" })
      .default(sql`((EXTRACT(epoch FROM now()) * (1000)`)
      .notNull(),
  },
  (table) => [
    unique("character_templates_templateUrl_unique").on(table.templateUrl),
  ],
);

export const npcKills = pgTable(
  "npc_kills",
  {
    id: serial().primaryKey().notNull(),
    playerId: text().notNull(),
    npcId: text().notNull(),
    killCount: integer().default(1).notNull(),
  },
  (table) => [
    index("idx_npc_kills_player").using(
      "btree",
      table.playerId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "npc_kills_playerId_characters_id_fk",
    }).onDelete("cascade"),
    unique("npc_kills_playerId_npcId_unique").on(table.playerId, table.npcId),
  ],
);

export const playerDeaths = pgTable(
  "player_deaths",
  {
    playerId: text().primaryKey().notNull(),
    gravestoneId: text(),
    groundItemIds: text(),
    position: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    timestamp: bigint({ mode: "number" }).notNull(),
    zoneType: text().notNull(),
    itemCount: integer().default(0).notNull(),
    items: jsonb().default([]).notNull(),
    keptItems: jsonb().default([]).notNull(),
    deathOperationId: text(),
    killedBy: text().default("unknown").notNull(),
    recovered: boolean().default(false).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    createdAt: bigint({ mode: "number" })
      .default(sql`((EXTRACT(epoch FROM now()) * (1000)`)
      .notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    updatedAt: bigint({ mode: "number" })
      .default(sql`((EXTRACT(epoch FROM now()) * (1000)`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("player_deaths_death_operation_id_unique")
      .on(table.deathOperationId)
      .where(sql`${table.deathOperationId} IS NOT NULL`),
    index("idx_player_deaths_recovered").using(
      "btree",
      table.recovered.asc().nullsLast().op("bool_ops"),
    ),
    index("idx_player_deaths_recovery_lookup").using(
      "btree",
      table.recovered.asc().nullsLast().op("bool_ops"),
      table.timestamp.asc().nullsLast().op("int8_ops"),
    ),
    index("idx_player_deaths_timestamp").using(
      "btree",
      table.timestamp.asc().nullsLast().op("int8_ops"),
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "player_deaths_playerId_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const gatheringResourceStates = pgTable(
  "gathering_resource_states",
  {
    resourceId: text("resource_id").primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    depletedAt: bigint("depleted_at", { mode: "number" }).notNull(),
    respawnAt: bigint("respawn_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("gathering_resource_states_operation_unique").on(
      table.operationId,
    ),
    index("idx_gathering_resource_states_respawn").on(table.respawnAt),
  ],
);

export const questGatheringProgressReceipts = pgTable(
  "quest_gathering_progress_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    playerId: text("player_id").notNull(),
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
  (table) => [
    uniqueIndex("quest_gathering_progress_receipts_operation_quest_unique").on(
      table.operationId,
      table.questId,
    ),
    index("idx_quest_gathering_progress_receipts_pending_player").on(
      table.playerId,
      table.resolvedAt,
      table.createdAt,
      table.id,
    ),
    index("idx_quest_gathering_progress_receipts_incarnation").on(
      table.playerId,
      table.questId,
      table.questStartedAt,
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "quest_gathering_progress_receipts_player_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const questProcessingProgressReceipts = pgTable(
  "quest_processing_progress_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    playerId: text("player_id").notNull(),
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
  (table) => [
    uniqueIndex(
      "quest_processing_progress_receipts_operation_quest_target_unique",
    ).on(table.operationId, table.questId, table.targetId),
    index("idx_quest_processing_progress_receipts_pending_player").on(
      table.playerId,
      table.resolvedAt,
      table.createdAt,
      table.id,
    ),
    index("idx_quest_processing_progress_receipts_incarnation").on(
      table.playerId,
      table.questId,
      table.questStartedAt,
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "quest_processing_progress_receipts_player_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const questKillProgressReceipts = pgTable(
  "quest_kill_progress_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    playerId: text("player_id").notNull(),
    questId: text("quest_id").notNull(),
    questStartedAt: bigint("quest_started_at", { mode: "number" }).notNull(),
    capturedStage: text("captured_stage").notNull(),
    mobId: text("mob_id").notNull(),
    mobType: text("mob_type").notNull(),
    quantity: integer("quantity").default(1).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    resolution: text("resolution"),
    resultingStage: text("resulting_stage"),
    resultingProgress: jsonb("resulting_progress"),
  },
  (table) => [
    uniqueIndex("quest_kill_progress_receipts_operation_quest_unique").on(
      table.operationId,
      table.questId,
    ),
    index("idx_quest_kill_progress_receipts_pending_player").on(
      table.playerId,
      table.resolvedAt,
      table.createdAt,
      table.id,
    ),
    index("idx_quest_kill_progress_receipts_incarnation").on(
      table.playerId,
      table.questId,
      table.questStartedAt,
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "quest_kill_progress_receipts_player_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const processingActiveFires = pgTable(
  "processing_active_fires",
  {
    fireId: text("fire_id").primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    playerId: text("player_id").notNull(),
    positionX: doublePrecision("position_x").notNull(),
    positionY: doublePrecision("position_y").notNull(),
    positionZ: doublePrecision("position_z").notNull(),
    tileX: integer("tile_x").notNull(),
    tileZ: integer("tile_z").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    extinguishedAt: bigint("extinguished_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("processing_active_fires_operation_unique").on(
      table.operationId,
    ),
    index("idx_processing_active_fires_expiry").on(
      table.extinguishedAt,
      table.expiresAt,
    ),
    index("idx_processing_active_fires_tile").on(
      table.tileX,
      table.tileZ,
      table.extinguishedAt,
      table.expiresAt,
    ),
    uniqueIndex("processing_active_fires_active_tile_unique")
      .on(table.tileX, table.tileZ)
      .where(sql`${table.extinguishedAt} IS NULL`),
    index("idx_processing_active_fires_player").on(
      table.playerId,
      table.extinguishedAt,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [characters.id],
      name: "processing_active_fires_player_id_characters_id_fk",
    }).onDelete("cascade"),
  ],
);

export const groundItemSources = pgTable(
  "ground_item_sources",
  {
    sourceId: text("source_id").primaryKey().notNull(),
    status: text("status").default("active").notNull(),
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
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    uniqueIndex("uidx_ground_item_sources_claimed_operation")
      .on(table.claimedByOperationId)
      .where(sql`${table.claimedByOperationId} IS NOT NULL`),
    index("idx_ground_item_sources_active_expiry").on(
      table.status,
      table.expiresAt,
      table.sourceId,
    ),
    index("idx_ground_item_sources_active_merge").on(
      table.status,
      table.tileX,
      table.tileZ,
      table.itemId,
      table.droppedBy,
      table.expiresAt,
    ),
    check(
      "ground_item_sources_status_check",
      sql`${table.status} IN ('active', 'claimed', 'expired')`,
    ),
    check(
      "ground_item_sources_identity_check",
      sql`${table.sourceId} ~ '^ground_item_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND length(${table.itemId}) BETWEEN 1 AND 256 AND (${table.droppedBy} IS NULL OR length(${table.droppedBy}) BETWEEN 1 AND 128)`,
    ),
    check(
      "ground_item_sources_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "ground_item_sources_lifetime_check",
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt} AND ${table.expiresAt} > ${table.createdAt} AND (${table.lootProtectionExpiresAt} IS NULL OR ${table.lootProtectionExpiresAt} BETWEEN ${table.createdAt} AND ${table.expiresAt})`,
    ),
    check(
      "ground_item_sources_position_check",
      sql`${table.positionX} > '-Infinity'::double precision AND ${table.positionX} < 'Infinity'::double precision AND ${table.positionY} > '-Infinity'::double precision AND ${table.positionY} < 'Infinity'::double precision AND ${table.positionZ} > '-Infinity'::double precision AND ${table.positionZ} < 'Infinity'::double precision`,
    ),
    check(
      "ground_item_sources_claim_check",
      sql`(${table.status} = 'claimed' AND ${table.claimedByOperationId} IS NOT NULL AND ${table.claimedByPlayerId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL) OR (${table.status} <> 'claimed' AND ${table.claimedByOperationId} IS NULL AND ${table.claimedByPlayerId} IS NULL AND ${table.claimedAt} IS NULL)`,
    ),
    check("ground_item_sources_version_check", sql`${table.version} >= 1`),
  ],
);

export const groundItemSourceContributions = pgTable(
  "ground_item_source_contributions",
  {
    contributionId: text("contribution_id").primaryKey().notNull(),
    sourceId: text("source_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    contributedAt: bigint("contributed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_ground_item_source_contributions_source").on(
      table.sourceId,
      table.contributedAt,
      table.contributionId,
    ),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [groundItemSources.sourceId],
      name: "ground_item_source_contributions_source_fk",
    }).onDelete("restrict"),
    check(
      "ground_item_source_contributions_identity_check",
      sql`${table.contributionId} ~ '^ground-item-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${table.requestFingerprint} ~ '^[0-9a-f]{64}$' AND length(${table.itemId}) BETWEEN 1 AND 256`,
    ),
    check(
      "ground_item_source_contributions_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 2147483647`,
    ),
  ],
);
