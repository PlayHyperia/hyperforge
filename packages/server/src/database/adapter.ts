/**
 * Drizzle Database Adapter
 *
 * This adapter bridges the gap between the legacy database interface (designed for Knex/SQL builders)
 * and the new Drizzle ORM interface. It allows existing systems to continue using the old query API
 * while the underlying implementation uses Drizzle.
 *
 * **Purpose**:
 * The shared package defines a `SystemDatabase` interface that was designed around Knex-style
 * query builders with chaining methods like `where().first()`. Rather than rewriting all systems
 * to use Drizzle directly, this adapter translates the old interface to Drizzle queries.
 *
 * **Supported Tables**:
 * - `storage`: Key-value store for world settings and configuration
 * - `config`: System configuration and feature flags
 * - `agent_credential_sessions`: read-only active-session authentication lookup
 * - Other tables: rejected (use DatabaseSystem directly for these)
 *
 * **Migration Path**:
 * This adapter is a temporary bridge. New code should use DatabaseSystem methods directly.
 * As systems are refactored, they can move away from this adapter pattern.
 *
 * **Query Translation Examples**:
 * ```typescript
 * // Old interface (what systems call)
 * await db('storage').where('key', userId).first()
 *
 * // Translates to Drizzle
 * await db.select().from(schema.storage)
 *   .where(eq(schema.storage.key, userId))
 *   .limit(1)
 * ```
 *
 * **Referenced by**: index.ts (world initialization), Storage system, ServerNetwork
 */

/**
 * Drizzle Adapter - Bridge between Drizzle ORM and Legacy Database Interface
 *
 * This adapter provides backward compatibility for systems that were built with
 * the old Knex-based database interface. It wraps Drizzle ORM operations to
 * match the expected method signatures of the legacy SystemDatabase interface.
 *
 * **Why this exists**:
 * - Legacy systems (Storage, ServerNetwork) expect a Knex-like query builder API
 * - We migrated to Drizzle ORM for better TypeScript support
 * - Rather than rewrite all consumers, we provide this compatibility layer
 *
 * **Supported tables**:
 * - `storage` - Key-value storage for system state
 * - `config` - Server configuration (spawn points, settings, etc.)
 * - `agent_credential_sessions` - read-only credential-session lookup
 * - Other tables fail closed
 *
 * **Architecture**:
 * The adapter mimics Knex's chaining API:
 * ```typescript
 * // Legacy Knex style:
 * db('storage').where('key', 'spawn').first()
 *
 * // Becomes Drizzle:
 * db.select().from(schema.storage).where(eq(schema.storage.key, 'spawn')).limit(1)
 * ```
 *
 * **Usage**:
 * ```typescript
 * const adapter = createDrizzleAdapter(drizzleDb);
 * const spawn = await adapter('config').where('key', 'spawn').first();
 * ```
 *
 * **Future**:
 * This adapter is temporary. Eventually all systems should migrate to native Drizzle queries.
 *
 * **Referenced by**: index.ts (ServerNetwork/Storage initialization)
 */

import { eq, and, or, isNull, gt, SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SystemDatabase } from "@hyperforge/shared";
import * as schema from "./schema";

// Type for condition groups (AND/OR) - used by query builder for complex conditions
type _ConditionGroup = {
  type: "and" | "or";
  conditions: SQL[];
};

/**
 * Create a Drizzle adapter that implements the SystemDatabase interface
 *
 * The returned function acts as a table selector (like Knex), and returns
 * an object with query builder methods that internally use Drizzle.
 *
 * @param db - The Drizzle database instance to wrap
 * @returns A function that takes a table name and returns query builder methods
 */
/**
 * Creates a Drizzle adapter that implements a subset of the SystemDatabase interface.
 * This is a compatibility layer - not all QueryBuilder methods are implemented for all tables.
 * Use the DatabaseSystem class directly for full functionality.
 *
 * Note: This adapter uses relaxed typing because it only implements the methods actually
 * used by systems. The full QueryBuilder interface requires methods like whereIn, whereRaw
 * which are not needed for the simple queries this adapter handles.
 */
export function createDrizzleAdapter(db: NodePgDatabase<typeof schema>) {
  // The adapter implements the subset of QueryBuilder methods actually used by systems.
  // TypeScript strict mode requires full interface implementation, so we use 'any' return.
  // This is safe because the adapter is only used by systems that use the implemented methods.
  const adapter = function (tableName: string): any {
    // ========================================================================
    // STORAGE TABLE ADAPTER
    // ========================================================================
    // The storage table is used by the Storage system for key-value persistence.
    // Provides CRUD operations that match the Knex API.
    if (tableName === "storage") {
      return {
        // WHERE clause - filters by key and returns query methods
        where: (key: string, value: unknown) => ({
          first: async () => {
            const results = await db
              .select()
              .from(schema.storage)
              .where(eq(schema.storage.key, value as string))
              .limit(1);
            return results[0];
          },
          update: async (data: Record<string, unknown>) => {
            await db
              .update(schema.storage)
              .set(data)
              .where(eq(schema.storage.key, value as string));
            return 1;
          },
          delete: async () => {
            await db
              .delete(schema.storage)
              .where(eq(schema.storage.key, value as string));
            return 1;
          },
        }),
        select: () => ({
          where: (key: string, value: unknown) => ({
            first: async () => {
              const results = await db
                .select()
                .from(schema.storage)
                .where(eq(schema.storage.key, value as string))
                .limit(1);
              return results[0];
            },
          }),
        }),
        insert: async (
          data: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          type StorageInsert = typeof schema.storage.$inferInsert;
          const rows = Array.isArray(data) ? data : [data];
          await db.insert(schema.storage).values(rows as StorageInsert[]);
        },
        update: async (data: Record<string, unknown>) => {
          await db.update(schema.storage).set(data);
          return 1;
        },
        delete: async () => {
          await db.delete(schema.storage);
          return 1;
        },
        first: async () => {
          const results = await db.select().from(schema.storage).limit(1);
          return results[0];
        },
        then: async <T>(onfulfilled: (value: unknown[]) => T) => {
          const results = await db.select().from(schema.storage);
          return onfulfilled(results);
        },
        catch: async <T>(onrejected: (reason: unknown) => T) => {
          try {
            const results = await db.select().from(schema.storage);
            return results as unknown as T;
          } catch (error) {
            return onrejected(error);
          }
        },
      };
    }

    // ========================================================================
    // CONFIG TABLE ADAPTER
    // ========================================================================
    // The config table stores server configuration like spawn points and settings.
    // Used by ServerNetwork during initialization.
    if (tableName === "config") {
      return {
        where: (key: string, value: unknown) => ({
          first: async () => {
            const results = await db
              .select()
              .from(schema.config)
              .where(eq(schema.config.key, value as string))
              .limit(1);
            return results[0];
          },
          update: async (data: Record<string, unknown>) => {
            await db
              .update(schema.config)
              .set(data)
              .where(eq(schema.config.key, value as string));
            return 1;
          },
          delete: async () => {
            await db
              .delete(schema.config)
              .where(eq(schema.config.key, value as string));
            return 1;
          },
        }),
        select: () => ({
          where: (key: string, value: unknown) => ({
            first: async () => {
              const results = await db
                .select()
                .from(schema.config)
                .where(eq(schema.config.key, value as string))
                .limit(1);
              return results[0];
            },
          }),
        }),
        insert: async (
          data: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          type ConfigInsert = typeof schema.config.$inferInsert;
          const rows = Array.isArray(data) ? data : [data];
          await db.insert(schema.config).values(rows as ConfigInsert[]);
        },
        update: async (data: Record<string, unknown>) => {
          await db.update(schema.config).set(data);
          return 1;
        },
        delete: async () => {
          await db.delete(schema.config);
          return 1;
        },
        first: async () => {
          const results = await db.select().from(schema.config).limit(1);
          return results[0];
        },
        then: async <T>(onfulfilled: (value: unknown[]) => T) => {
          const results = await db.select().from(schema.config);
          return onfulfilled(results);
        },
        catch: async <T>(onrejected: (reason: unknown) => T) => {
          try {
            const results = await db.select().from(schema.config);
            return results as unknown as T;
          } catch (error) {
            return onrejected(error);
          }
        },
      };
    }

    // ========================================================================
    // USERS TABLE ADAPTER
    // ========================================================================
    // The users table stores user accounts and authentication data.
    // Used by ServerNetwork authentication flow.
    if (tableName === "users") {
      return {
        where: (key: string, value: unknown) => {
          // Type-safe column access for users table with runtime validation
          const column = schema.users[key as keyof typeof schema.users];
          if (!column) {
            throw new Error(`Invalid column name for users table: ${key}`);
          }

          return {
            first: async () => {
              const results = await db
                .select()
                .from(schema.users)
                // @ts-expect-error - Column type verified at runtime
                .where(eq(column, value as string))
                .limit(1);
              return results[0];
            },
            update: async (data: Record<string, unknown>) => {
              await db
                .update(schema.users)
                .set(data as Partial<typeof schema.users.$inferInsert>)
                // @ts-expect-error - Column type verified at runtime
                .where(eq(column, value as string));
              return 1;
            },
            delete: async () => {
              await db
                .delete(schema.users)
                // @ts-expect-error - Column type verified at runtime
                .where(eq(column, value as string));
              return 1;
            },
          };
        },
        select: () => ({
          where: (key: string, value: unknown) => {
            const column = schema.users[key as keyof typeof schema.users];
            if (!column) {
              throw new Error(`Invalid column name for users table: ${key}`);
            }

            return {
              first: async () => {
                const results = await db
                  .select()
                  .from(schema.users)
                  // @ts-expect-error - Column type verified at runtime
                  .where(eq(column, value as string))
                  .limit(1);
                return results[0];
              },
            };
          },
        }),
        insert: async (
          data: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          type UsersInsert = typeof schema.users.$inferInsert;
          const rows = Array.isArray(data) ? data : [data];
          await db.insert(schema.users).values(rows as UsersInsert[]);
        },
        update: async (data: Record<string, unknown>) => {
          await db
            .update(schema.users)
            .set(data as Partial<typeof schema.users.$inferInsert>);
          return 1;
        },
        delete: async () => {
          await db.delete(schema.users);
          return 1;
        },
        first: async () => {
          const results = await db.select().from(schema.users).limit(1);
          return results[0];
        },
        then: async <T>(onfulfilled: (value: unknown[]) => T) => {
          const results = await db.select().from(schema.users);
          return onfulfilled(results);
        },
        catch: async <T>(onrejected: (reason: unknown) => T) => {
          try {
            const results = await db.select().from(schema.users);
            return results as unknown as T;
          } catch (error) {
            return onrejected(error);
          }
        },
      };
    }

    // ========================================================================
    // AGENT_CREDENTIAL_SESSIONS TABLE ADAPTER
    // ========================================================================
    // Agent WebSocket authentication is wired through this production adapter.
    // Keep the surface deliberately read-only and limited to the exact primary-
    // key lookup used by verifyAgentCredentialSessionWithSystemDatabase().
    // Drizzle returns camelCase fields while the legacy SystemDatabase verifier
    // consumes database column names, so normalize the row at this boundary.
    if (tableName === "agent_credential_sessions") {
      const readBySessionId = async (sessionId: unknown) => {
        if (typeof sessionId !== "string") return undefined;
        const rows = await db
          .select()
          .from(schema.agentCredentialSessions)
          .where(eq(schema.agentCredentialSessions.sessionId, sessionId))
          .limit(1);
        const row = rows[0];
        if (!row) return undefined;
        return {
          session_id: row.sessionId,
          account_id: row.accountId,
          character_id: row.characterId,
          auth_method: row.authMethod,
          issued_at: row.issuedAt,
          expires_at: row.expiresAt,
          revoked_at: row.revokedAt,
          revoked_reason: row.revokedReason,
        };
      };

      return {
        where: (key: string, value: unknown) => {
          if (key !== "session_id") {
            throw new Error(
              `[DatabaseAdapter] Unsupported agent credential session lookup column "${key}"`,
            );
          }
          return {
            first: () => readBySessionId(value),
          };
        },
      };
    }

    // ========================================================================
    // USER_BANS TABLE ADAPTER
    // ========================================================================
    // The user_bans table stores ban records for the moderation system.
    // Supports chainable query building for complex ban lookups.
    if (tableName === "user_bans") {
      // Create a chainable query builder for user_bans
      type UserBansColumns = keyof typeof schema.userBans;

      // Helper to get column from schema with runtime validation
      const getColumn = (key: string) => {
        const column = schema.userBans[key as UserBansColumns];
        if (!column) {
          throw new Error(`Invalid column name for user_bans table: ${key}`);
        }
        return column;
      };

      // Helper to build SQL condition from key/value/operator
      const buildCondition = (
        key: string,
        operatorOrValue: string | number,
        maybeValue?: string | number | null,
      ): SQL => {
        const column = getColumn(key);
        // Two-arg form: where(key, value) - equality
        if (maybeValue === undefined) {
          // @ts-expect-error - Column type verified at runtime
          return eq(column, operatorOrValue);
        }
        // Three-arg form: where(key, operator, value)
        const operator = operatorOrValue as string;
        if (operator === ">") {
          // @ts-expect-error - Column type verified at runtime
          return gt(column, maybeValue as number);
        }
        // Default to equality for unknown operators
        // @ts-expect-error - Column type verified at runtime
        return eq(column, maybeValue);
      };

      // Explicit interface to break circular `typeof builder` inference
      interface BanQueryBuilder {
        where(
          keyOrCallback: string | ((this: BanQueryBuilder) => void),
          operatorOrValue?: string | number,
          maybeValue?: string | number | null,
        ): BanQueryBuilder;
        whereNull(key: string): BanQueryBuilder;
        orWhere(
          key: string,
          operatorOrValue: string | number,
          maybeValue?: string | number | null,
        ): BanQueryBuilder;
        first(): Promise<unknown>;
        select(...columns: string[]): {
          then: <T>(onfulfilled: (value: unknown[]) => T) => Promise<T>;
        };
        update(data: Record<string, unknown>): Promise<number>;
        delete(): Promise<number>;
        then: <T>(onfulfilled: (value: unknown[]) => T) => Promise<T>;
        _conditions: SQL[];
        _orConditions: SQL[];
      }

      // Create a chainable builder
      const createBuilder = (
        conditions: SQL[] = [],
        orConditions: SQL[] = [],
      ): BanQueryBuilder => {
        // Build final WHERE clause
        const buildWhere = (): SQL | undefined => {
          const allConditions: SQL[] = [...conditions];
          if (orConditions.length > 0) {
            // Wrap OR conditions together
            allConditions.push(or(...orConditions)!);
          }
          if (allConditions.length === 0) return undefined;
          if (allConditions.length === 1) return allConditions[0];
          return and(...allConditions);
        };

        const builder: BanQueryBuilder = {
          // Chainable where - supports (key, value), (key, op, value), and callback forms
          where(
            keyOrCallback: string | ((this: BanQueryBuilder) => void),
            operatorOrValue?: string | number,
            maybeValue?: string | number | null,
          ): BanQueryBuilder {
            if (typeof keyOrCallback === "function") {
              // Callback form: where(function() { this.whereNull(...).orWhere(...) })
              // In Knex, conditions inside a callback with orWhere form an OR group
              // e.g., .where(function() { this.whereNull("x").orWhere("y", ">", 1) })
              // produces: (x IS NULL OR y > 1)
              const subBuilder = createBuilder([], []);
              keyOrCallback.call(subBuilder);
              const subOrConditions = subBuilder._orConditions || [];
              const subConditions = subBuilder._conditions || [];

              // Combine all conditions from the callback with OR semantics
              // When there are orWhere calls, everything should be ORed together
              const allSubConditions: SQL[] = [
                ...subConditions,
                ...subOrConditions,
              ];
              if (allSubConditions.length > 0) {
                // If there are any orWhere conditions, use OR for everything
                // Otherwise use AND (standard where chaining within callback)
                if (subOrConditions.length > 0) {
                  // OR all conditions together: (cond1 OR cond2 OR ...)
                  conditions.push(
                    allSubConditions.length === 1
                      ? allSubConditions[0]
                      : or(...allSubConditions)!,
                  );
                } else {
                  // No orWhere, use AND for where chaining
                  conditions.push(
                    allSubConditions.length === 1
                      ? allSubConditions[0]
                      : and(...allSubConditions)!,
                  );
                }
              }
              return builder;
            }
            // Standard where(key, value) or where(key, op, value)
            conditions.push(
              buildCondition(keyOrCallback, operatorOrValue!, maybeValue),
            );
            return builder;
          },

          // whereNull(key) - check for NULL values
          whereNull(key: string): BanQueryBuilder {
            const column = getColumn(key);
            // @ts-expect-error - Column type verified at runtime
            conditions.push(isNull(column));
            return builder;
          },

          // orWhere(key, op, value) - add OR condition
          orWhere(
            key: string,
            operatorOrValue: string | number,
            maybeValue?: string | number | null,
          ): BanQueryBuilder {
            orConditions.push(buildCondition(key, operatorOrValue, maybeValue));
            return builder;
          },

          // Terminal: first() - get first matching row
          async first() {
            const whereClause = buildWhere();
            let query = db.select().from(schema.userBans);
            if (whereClause) {
              query = query.where(whereClause) as typeof query;
            }
            const results = await query.limit(1);
            return results[0];
          },

          // Terminal: select(...columns) - get selected columns
          select(...columns: string[]) {
            return {
              then: async <T>(onfulfilled: (value: unknown[]) => T) => {
                const whereClause = buildWhere();
                // Build select - always select all columns for simplicity
                // Column filtering would need more complex type handling
                let query = db.select().from(schema.userBans);
                if (whereClause) {
                  query = query.where(whereClause) as typeof query;
                }
                const results = await query;
                // If specific columns requested, filter the results
                if (columns.length > 0) {
                  const filteredResults = results.map((row) => {
                    const filtered: Record<string, unknown> = {};
                    for (const col of columns) {
                      filtered[col] = (row as Record<string, unknown>)[col];
                    }
                    return filtered;
                  });
                  return onfulfilled(filteredResults);
                }
                return onfulfilled(results);
              },
            };
          },

          // Terminal: update(data) - update matching rows
          async update(data: Record<string, unknown>) {
            const whereClause = buildWhere();
            const baseQuery = db
              .update(schema.userBans)
              .set(data as Partial<typeof schema.userBans.$inferInsert>);
            if (whereClause) {
              // Type assertion needed because Drizzle types are overly strict here
              await (
                baseQuery as { where: (clause: SQL) => Promise<unknown> }
              ).where(whereClause);
            } else {
              await baseQuery;
            }
            return 1;
          },

          // Terminal: delete() - delete matching rows
          async delete() {
            const whereClause = buildWhere();
            const baseQuery = db.delete(schema.userBans);
            if (whereClause) {
              // Type assertion needed because Drizzle types are overly strict here
              await (
                baseQuery as { where: (clause: SQL) => Promise<unknown> }
              ).where(whereClause);
            } else {
              await baseQuery;
            }
            return 1;
          },

          // Promise interface for direct await
          then: async <T>(onfulfilled: (value: unknown[]) => T) => {
            const whereClause = buildWhere();
            let query = db.select().from(schema.userBans);
            if (whereClause) {
              query = query.where(whereClause) as typeof query;
            }
            const results = await query;
            return onfulfilled(results);
          },

          // Expose internal state for nested builders (callback where)
          _conditions: conditions,
          _orConditions: orConditions,
        };

        return builder;
      };

      // Return initial builder with table-level methods
      return {
        where(
          keyOrCallback: string | ((this: BanQueryBuilder) => void),
          operatorOrValue?: string | number,
          maybeValue?: string | number | null,
        ) {
          const builder = createBuilder();
          return builder.where(keyOrCallback, operatorOrValue, maybeValue);
        },
        select(...columns: string[]) {
          return createBuilder().select(...columns);
        },
        insert: async (
          data: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          type UserBansInsert = typeof schema.userBans.$inferInsert;
          const rows = Array.isArray(data) ? data : [data];
          await db.insert(schema.userBans).values(rows as UserBansInsert[]);
        },
        first: async () => {
          const results = await db.select().from(schema.userBans).limit(1);
          return results[0];
        },
        then: async <T>(onfulfilled: (value: unknown[]) => T) => {
          const results = await db.select().from(schema.userBans);
          return onfulfilled(results);
        },
        catch: async <T>(onrejected: (reason: unknown) => T) => {
          try {
            const results = await db.select().from(schema.userBans);
            return results as unknown as T;
          } catch (error) {
            return onrejected(error);
          }
        },
      };
    }

    // ========================================================================
    // FALLBACK ADAPTER (OTHER TABLES)
    // ========================================================================
    // For tables not specifically implemented, throw to avoid silent no-ops.
    // These tables should use DatabaseSystem directly instead of the adapter.
    throw new Error(
      `[DatabaseAdapter] Unsupported table "${tableName}". Use DatabaseSystem instead.`,
    );
  };
  // Cast to SystemDatabase - the adapter implements the subset of methods actually used
  return adapter as any as SystemDatabase;
}
