import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type ConnectablePool = Pick<pg.Pool, "connect">;

type PersistedParticipationRow = {
  agentId: string;
  accountId: string;
  characterId: string;
  agentName: string;
  streamingDuelEnabled: boolean;
};

export type PersistedStreamingDuelParticipationMutation =
  | {
      status: "updated";
      mapping: PersistedParticipationRow;
    }
  | { status: "forbidden" }
  | {
      status: "market_locked";
      characterId: string;
    };

export type PersistedStreamingDuelMappingDeletion =
  | {
      status: "deleted";
      mapping: PersistedParticipationRow;
    }
  | { status: "forbidden" }
  | {
      status: "market_locked";
      characterId: string;
    };

export type PersistedAgentMappingSave =
  | {
      status: "saved";
      mapping: PersistedParticipationRow;
    }
  | { status: "character_forbidden" }
  | { status: "mapping_conflict" };

export type OwnedAgentMutationResult<T> =
  | {
      status: "completed";
      mapping: PersistedParticipationRow;
      value: T;
    }
  | { status: "forbidden" }
  | {
      status: "market_locked";
      characterId: string;
    };

const normalizeContestantIds = (contestantIds: readonly string[]): string[] => {
  const normalized = [...new Set(contestantIds)].sort();
  if (
    normalized.length !== 2 ||
    normalized.some((contestantId) => contestantId.length === 0)
  ) {
    throw new Error("competitive participation requires two distinct agents");
  }
  return normalized;
};

/**
 * Lock and verify both persisted opt-ins inside the caller's transaction.
 * Snapshot creation and owner mutation deliberately share this row lock so an
 * opt-out cannot race a money-bearing market freeze.
 */
export async function lockAndAssertPersistedStreamingDuelParticipation(
  queryable: Queryable,
  contestantIds: readonly string[],
): Promise<void> {
  const normalized = normalizeContestantIds(contestantIds);
  const result = await queryable.query<{
    characterId: string;
    streamingDuelEnabled: boolean;
  }>(
    `
      SELECT
        "character_id" AS "characterId",
        "streaming_duel_enabled" AS "streamingDuelEnabled"
      FROM "agent_mappings"
      WHERE "character_id" = ANY($1::text[])
      ORDER BY "character_id"
      FOR UPDATE
    `,
    [normalized],
  );
  const enabledIds = result.rows
    .filter((row) => row.streamingDuelEnabled === true)
    .map((row) => row.characterId)
    .sort();
  if (
    enabledIds.length !== normalized.length ||
    enabledIds.some((contestantId, index) => contestantId !== normalized[index])
  ) {
    throw new Error("competitive_contestant_participation_not_enabled");
  }
}

const lockOwnedMapping = async (
  queryable: Queryable,
  agentId: string,
  accountId: string,
): Promise<PersistedParticipationRow | null> => {
  const result = await queryable.query<PersistedParticipationRow>(
    `
      SELECT
        "agent_id" AS "agentId",
        "account_id" AS "accountId",
        "character_id" AS "characterId",
        "agent_name" AS "agentName",
        "streaming_duel_enabled" AS "streamingDuelEnabled"
      FROM "agent_mappings"
      WHERE "agent_id" = $1 OR "character_id" = $1
      FOR UPDATE
    `,
    [agentId],
  );
  const mapping = result.rows[0] ?? null;
  return mapping?.accountId === accountId ? mapping : null;
};

const hasActiveFrozenMarket = async (
  queryable: Queryable,
  characterId: string,
): Promise<boolean> => {
  const result = await queryable.query<{ locked: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM "streaming_duel_preparations" AS preparation
        INNER JOIN "streaming_duel_competitive_snapshots" AS snapshot
          ON snapshot."preparationId" = preparation."preparationId"
        WHERE snapshot."lifecycleStatus" IN ('frozen', 'terminal')
          AND (
            preparation."agent1Id" = $1 OR
            preparation."agent2Id" = $1
          )
      ) AS locked
    `,
    [characterId],
  );
  return result.rows[0]?.locked === true;
};

export async function updatePersistedStreamingDuelParticipation(input: {
  pool: ConnectablePool;
  agentId: string;
  accountId: string;
  enabled: boolean;
}): Promise<PersistedStreamingDuelParticipationMutation> {
  const client = await input.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const mapping = await lockOwnedMapping(
      client,
      input.agentId,
      input.accountId,
    );
    if (!mapping) {
      return { status: "forbidden" };
    }
    if (
      !input.enabled &&
      (await hasActiveFrozenMarket(client, mapping.characterId))
    ) {
      return {
        status: "market_locked",
        characterId: mapping.characterId,
      };
    }
    const updatedResult = await client.query<PersistedParticipationRow>(
      `
        UPDATE "agent_mappings"
        SET
          "streaming_duel_enabled" = $3,
          "updated_at" = NOW()
        WHERE "agent_id" = $1 AND "account_id" = $2
        RETURNING
          "agent_id" AS "agentId",
          "account_id" AS "accountId",
          "character_id" AS "characterId",
          "agent_name" AS "agentName",
          "streaming_duel_enabled" AS "streamingDuelEnabled"
      `,
      [mapping.agentId, input.accountId, input.enabled],
    );
    const updated = updatedResult.rows[0];
    if (!updated) {
      throw new Error("streaming_duel_participation_update_lost");
    }
    await client.query("COMMIT");
    committed = true;
    return { status: "updated", mapping: updated };
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original mutation failure.
      }
    }
    client.release();
  }
}

/**
 * Hold the same mapping-row lock used by market freeze across a disruptive
 * owner mutation. This prevents stop/pause/remove from slipping between a
 * "not active" check and competitive snapshot creation.
 */
export async function executeOwnedAgentMutation<T>(input: {
  pool: ConnectablePool;
  routeAgentId: string;
  accountId: string;
  deleteMappingAfterMutation?: boolean;
  mutate: (mapping: PersistedParticipationRow) => Promise<T>;
}): Promise<OwnedAgentMutationResult<T>> {
  const client = await input.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const mapping = await lockOwnedMapping(
      client,
      input.routeAgentId,
      input.accountId,
    );
    if (!mapping) return { status: "forbidden" };
    if (await hasActiveFrozenMarket(client, mapping.characterId)) {
      return {
        status: "market_locked",
        characterId: mapping.characterId,
      };
    }
    const value = await input.mutate(mapping);
    if (input.deleteMappingAfterMutation === true) {
      const deletion = await client.query(
        `DELETE FROM "agent_mappings"
         WHERE "agent_id" = $1 AND "account_id" = $2`,
        [mapping.agentId, mapping.accountId],
      );
      if (deletion.rowCount !== 1) {
        throw new Error("owned_agent_mapping_delete_lost");
      }
    }
    await client.query("COMMIT");
    committed = true;
    return { status: "completed", mapping, value };
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original mutation failure.
      }
    }
    client.release();
  }
}

/**
 * Create dashboard identity without granting competitive participation.
 * Existing mapping ownership/character identity is immutable through this
 * route; only the display name may be refreshed and the persisted opt-in is
 * always preserved.
 */
export async function savePersistedAgentMapping(input: {
  pool: ConnectablePool;
  agentId: string;
  accountId: string;
  characterId: string;
  agentName: string;
}): Promise<PersistedAgentMappingSave> {
  const client = await input.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const characterResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM characters
        WHERE id = $1 AND "accountId" = $2
        FOR SHARE
      `,
      [input.characterId, input.accountId],
    );
    if (!characterResult.rows[0]) {
      return { status: "character_forbidden" };
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`agent-mapping:${input.agentId}`],
    );
    const existingResult = await client.query<PersistedParticipationRow>(
      `
        SELECT
          "agent_id" AS "agentId",
          "account_id" AS "accountId",
          "character_id" AS "characterId",
          "agent_name" AS "agentName",
          "streaming_duel_enabled" AS "streamingDuelEnabled"
        FROM "agent_mappings"
        WHERE "agent_id" = $1
        FOR UPDATE
      `,
      [input.agentId],
    );
    const existing = existingResult.rows[0];
    if (
      existing &&
      (existing.accountId !== input.accountId ||
        existing.characterId !== input.characterId)
    ) {
      return { status: "mapping_conflict" };
    }
    const savedResult = existing
      ? await client.query<PersistedParticipationRow>(
          `
            UPDATE "agent_mappings"
            SET "agent_name" = $2, "updated_at" = NOW()
            WHERE "agent_id" = $1
            RETURNING
              "agent_id" AS "agentId",
              "account_id" AS "accountId",
              "character_id" AS "characterId",
              "agent_name" AS "agentName",
              "streaming_duel_enabled" AS "streamingDuelEnabled"
          `,
          [input.agentId, input.agentName],
        )
      : await client.query<PersistedParticipationRow>(
          `
            INSERT INTO "agent_mappings" (
              "agent_id", "account_id", "character_id", "agent_name",
              "streaming_duel_enabled", "created_at", "updated_at"
            ) VALUES ($1, $2, $3, $4, false, NOW(), NOW())
            RETURNING
              "agent_id" AS "agentId",
              "account_id" AS "accountId",
              "character_id" AS "characterId",
              "agent_name" AS "agentName",
              "streaming_duel_enabled" AS "streamingDuelEnabled"
          `,
          [input.agentId, input.accountId, input.characterId, input.agentName],
        );
    const saved = savedResult.rows[0];
    if (!saved) throw new Error("agent_mapping_save_lost");
    await client.query("COMMIT");
    committed = true;
    return { status: "saved", mapping: saved };
  } catch (error) {
    const postgresCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (postgresCode === "23505") {
      return { status: "mapping_conflict" };
    }
    throw error;
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original mutation failure.
      }
    }
    client.release();
  }
}

export async function deletePersistedStreamingDuelMapping(input: {
  pool: ConnectablePool;
  agentId: string;
  accountId: string;
}): Promise<PersistedStreamingDuelMappingDeletion> {
  const client = await input.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const mapping = await lockOwnedMapping(
      client,
      input.agentId,
      input.accountId,
    );
    if (!mapping) {
      return { status: "forbidden" };
    }
    if (await hasActiveFrozenMarket(client, mapping.characterId)) {
      return {
        status: "market_locked",
        characterId: mapping.characterId,
      };
    }
    const deletedResult = await client.query<PersistedParticipationRow>(
      `
        DELETE FROM "agent_mappings"
        WHERE "agent_id" = $1 AND "account_id" = $2
        RETURNING
          "agent_id" AS "agentId",
          "account_id" AS "accountId",
          "character_id" AS "characterId",
          "agent_name" AS "agentName",
          "streaming_duel_enabled" AS "streamingDuelEnabled"
      `,
      [mapping.agentId, input.accountId],
    );
    const deleted = deletedResult.rows[0];
    if (!deleted) {
      throw new Error("streaming_duel_mapping_delete_lost");
    }
    await client.query("COMMIT");
    committed = true;
    return { status: "deleted", mapping: deleted };
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original mutation failure.
      }
    }
    client.release();
  }
}
