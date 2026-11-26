import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  World,
  DataManager,
  ResourceSystem,
  CollisionFlag,
} from "@hyperforge/shared";
import { ResourceEntity } from "../../../../../shared/src/entities/world/ResourceEntity";
import { EntityManager } from "../../../../../shared/src/systems/shared/entities/EntityManager";
import type { Resource } from "../../../../../shared/src/types/core/core";
import type { TerrainResourceSpawnBatch } from "../../../../../shared/src/types/world/terrain";
import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import { ServerNetwork } from "../../ServerNetwork/index.js";
import { BroadcastManager } from "../../ServerNetwork/broadcast.js";
import { DatabaseSystem } from "../index.js";

// Explicit opt-in: the test creates and drops a unique database, never tables in
// the supplied database. Use only an isolated test PostgreSQL service.
const baseDatabaseUrl =
  process.env.RESOURCE_REGISTRATION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const TICK_MS = 600;

class PersistenceWorld extends World {
  pgPool!: pg.Pool;
  drizzleDb!: ReturnType<typeof drizzle<typeof schema>>;

  override get isServer(): boolean {
    return true;
  }
}

/** Records production broadcast calls without replacing encoding or delivery.
 * There are no sockets: this proves batch publication, not transport delivery. */
class ObservedServerNetwork extends ServerNetwork {
  readonly publications: { name: string; data: unknown }[] = [];

  constructor(world: World) {
    super(world);
    // The actual production owner normally installs this in its broad init().
    // No socket listeners, timers, app services or fake send result are needed.
    (
      this as unknown as { broadcastManager: BroadcastManager }
    ).broadcastManager = new BroadcastManager(this.sockets);
  }

  override send<T>(name: string, data: T, ignoreSocketId?: string): void {
    super.send(name, data, ignoreSocketId);
    this.publications.push({ name, data });
  }

  override sendHighPriority<T>(
    name: string,
    data: T,
    ignoreSocketId?: string,
  ): void {
    super.sendHighPriority(name, data, ignoreSocketId);
    this.publications.push({ name, data });
  }
}

type ResourceInternals = {
  registerTerrainResources(batch: TerrainResourceSpawnBatch): Promise<void>;
  onTerrainTileUnloaded(data: {
    tileId: string;
    tileX: number;
    tileZ: number;
  }): void;
  resources: Map<string, Resource>;
  respawnAtTick: Map<string, number>;
  terrainResourceLeases: Map<string, unknown>;
  terrainResourceRegistrations: Map<string, unknown>;
  terrainResourceTails: Map<string, Promise<void>>;
};

function batch(x: number): TerrainResourceSpawnBatch {
  return {
    owner: { tileX: 2, tileZ: 2 },
    spawnPoints: [
      {
        id: `authored-input-${x}`,
        type: "tree",
        subType: "pine",
        position: { x, y: 12, z: 220.5 },
        scale: 1.125,
        rotation: 0.37,
      },
    ],
  };
}

function unload(resources: ResourceInternals): void {
  resources.onTerrainTileUnloaded({ tileId: "2,2", tileX: 2, tileZ: 2 });
}

describeDatabase(
  "ResourceSystem real PostgreSQL registration persistence",
  () => {
    let adminPool: pg.Pool;
    let pool: pg.Pool;
    let databaseName: string;
    const worlds: PersistenceWorld[] = [];

    beforeAll(async () => {
      await DataManager.getInstance().initialize();
      databaseName = `hyperia_resource_lease_${process.pid}_${Date.now().toString(36)}`;
      const adminUrl = new URL(baseDatabaseUrl);
      adminUrl.pathname = "/postgres";
      adminPool = new pg.Pool({
        connectionString: adminUrl.toString(),
        max: 2,
      });
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = new URL(baseDatabaseUrl);
      testUrl.pathname = `/${databaseName}`;
      pool = new pg.Pool({
        connectionString: testUrl.toString(),
        max: 4,
        application_name: databaseName,
        statement_timeout: 15_000,
      });
      const migrationClient = await pool.connect();
      try {
        await migrate(createPostgresClientDatabase(migrationClient), {
          migrationsFolder: path.resolve(
            import.meta.dirname,
            "../../../database/migrations",
          ),
        });
      } finally {
        migrationClient.release();
      }
      const db = drizzle(pool, { schema });
      await db.insert(schema.users).values({
        id: "registration-persistence-account",
        name: "Registration Persistence",
        roles: "user",
        createdAt: "2026-09-11T00:00:00.000Z",
      });
      await db.insert(schema.characters).values({
        id: "registration-persistence-player",
        accountId: "registration-persistence-account",
        name: "Registration Persistence",
      });
    }, 30_000);

    afterEach(() => {
      for (const world of worlds.splice(0)) world.destroy();
    });

    afterAll(async () => {
      await pool?.end();
      if (adminPool && databaseName) {
        try {
          await adminPool.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
            [databaseName],
          );
          await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally {
          await adminPool.end();
        }
      }
    }, 30_000);

    async function fixture() {
      const world = new PersistenceWorld();
      worlds.push(world);
      world.pgPool = pool;
      world.drizzleDb = drizzle(pool, { schema });
      const database = world.register(
        "database",
        DatabaseSystem,
      ) as DatabaseSystem;
      await database.init();
      // EntityManager is not a public package export. Vitest's server aliases
      // resolve the package and this direct import to the same source World;
      // server tsc otherwise compares source/build protected declaration brands.
      const manager = world.register(
        "entity-manager",
        EntityManager as unknown as Parameters<World["register"]>[1],
      ) as unknown as EntityManager;
      const system = world.register(
        "resource",
        ResourceSystem,
      ) as ResourceSystem;
      const network = new ObservedServerNetwork(world);
      // The unstarted observer has no services to tear down; real DB/entity/resource
      // systems are registered and destroyed normally by World.
      Object.defineProperty(world, "network", {
        value: network,
        writable: true,
        configurable: true,
      });
      return {
        world,
        database,
        manager,
        network,
        resources: system as unknown as ResourceInternals,
      };
    }

    async function commitDepletion(
      database: DatabaseSystem,
      resourceId: string,
    ) {
      const input = {
        playerId: "registration-persistence-player",
        resourceId,
        depleteAfterCommit: true,
        respawnTicks: 100,
        skill: "woodcutting" as const,
        xpAmount: 25,
        reward: { itemId: "logs", quantity: 1, stackable: false },
        secondaryItemId: null,
      };
      return database.commitGatheringRewardOperationAsync({
        operationId: randomUUID(),
        requestFingerprint: createHash("sha256")
          .update(JSON.stringify({ version: 2, ...input }))
          .digest("hex"),
        ...input,
      });
    }

    it("cancels a lease while its actual hydration SELECT is blocked, with no late entity or batch", async () => {
      const { database, world, manager, network, resources } = await fixture();
      const resourceId = "tree_211_221";
      await commitDepletion(database, resourceId);
      const locker = await pool.connect();
      let registration: Promise<void> | undefined;
      try {
        await locker.query("BEGIN");
        await locker.query(
          "LOCK TABLE gathering_resource_states IN ACCESS EXCLUSIVE MODE",
        );
        const {
          rows: [{ pid }],
        } = await locker.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        registration = resources.registerTerrainResources(batch(210.5));
        // Attach immediately so an unexpected query rejection cannot be unhandled.
        void registration.catch(() => undefined);
        const deadline = Date.now() + 5_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const result = await adminPool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = $1 AND wait_event_type = 'Lock'
               AND query ILIKE '%gathering_resource_states%'
               AND $2::integer = ANY(pg_blocking_pids(pid))
           ) AS blocked`,
            [databaseName, pid],
          );
          if (result.rows[0].blocked) {
            blocked = true;
            break;
          }
          await delay(20);
        }
        expect(
          blocked,
          "PostgreSQL must prove the real SELECT is blocked",
        ).toBe(true);
        expect(resources.terrainResourceLeases.size).toBe(1);
        expect(manager.getAllEntities().size).toBe(0);
        expect(network.publications).toEqual([]);
        unload(resources);
        expect(resources.terrainResourceLeases.size).toBe(0);
        await locker.query("COMMIT");
        await registration;
        expect(manager.getAllEntities().size).toBe(0);
        expect(world.entities.get(resourceId)).toBeNull();
        expect(world.collision.hasFlags(210, 220, CollisionFlag.BLOCKED)).toBe(
          false,
        );
        expect(resources.resources.size).toBe(0);
        expect(resources.respawnAtTick.size).toBe(0);
        expect(resources.terrainResourceRegistrations.size).toBe(0);
        expect(resources.terrainResourceTails.size).toBe(0);
        expect(network.publications).toEqual([]);
        expect(
          await database.getGatheringResourceStatesAsync([resourceId]),
        ).toHaveLength(1);
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
        await registration?.catch(() => undefined);
      }
    });

    it("reloads real committed depletion with the original absolute deadline, not a fresh duration", async () => {
      const { database, world, manager, network, resources } = await fixture();
      const resourceId = "tree_221_221";
      const receipt = await commitDepletion(database, resourceId);
      expect(receipt.replayed).toBe(false);
      expect(receipt.depletedUntil).toBeGreaterThan(Date.now());
      const durableBefore = await database.getGatheringResourceStatesAsync([
        resourceId,
      ]);
      expect(durableBefore).toHaveLength(1);
      const state = durableBefore[0];
      expect(state.respawnAt).toBe(receipt.depletedUntil);
      expect(state.respawnAt - state.depletedAt).toBe(100 * TICK_MS);

      world.currentTick = 1000;
      await resources.registerTerrainResources(batch(220.5));
      const original = manager.getEntity(resourceId);
      expect(original).toBeInstanceOf(ResourceEntity);
      expect(original?.serialize()).toMatchObject({ depleted: true });
      expect(resources.resources.get(resourceId)).toMatchObject({
        isAvailable: false,
        lastDepleted: state.depletedAt,
      });
      expect(
        network.publications.filter(
          ({ name }) => name === "entitiesBatchAdded",
        ),
      ).toHaveLength(1);
      const firstRemaining =
        resources.respawnAtTick.get(resourceId)! - world.currentTick;
      unload(resources);
      expect(manager.getEntity(resourceId)).toBeUndefined();
      expect(resources.respawnAtTick.has(resourceId)).toBe(false);

      // Real elapsed time and real PostgreSQL, never fake timers or injected maps.
      await delay(2 * TICK_MS + 50);
      world.currentTick += 2;
      const beforeReload = Date.now();
      await resources.registerTerrainResources(batch(220.5));
      const afterReload = Date.now();
      const reloaded = manager.getEntity(resourceId);
      expect(reloaded).toBeInstanceOf(ResourceEntity);
      expect(reloaded).not.toBe(original);
      expect(reloaded?.serialize()).toMatchObject({ depleted: true });
      expect(resources.resources.get(resourceId)).toMatchObject({
        isAvailable: false,
        lastDepleted: state.depletedAt,
      });
      const remaining =
        resources.respawnAtTick.get(resourceId)! - world.currentTick;
      expect(remaining).toBeLessThan(firstRemaining);
      expect(remaining).toBeGreaterThanOrEqual(
        Math.ceil((state.respawnAt - afterReload) / TICK_MS),
      );
      expect(remaining).toBeLessThanOrEqual(
        Math.ceil((state.respawnAt - beforeReload) / TICK_MS),
      );
      expect(
        await database.getGatheringResourceStatesAsync([resourceId]),
      ).toEqual(durableBefore);
      const batches = network.publications.filter(
        ({ name }) => name === "entitiesBatchAdded",
      );
      expect(batches).toHaveLength(2);
      expect(batches[1].data).toMatchObject([
        { id: resourceId, depleted: true },
      ]);
      const custody = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM operations_log WHERE "id" = $1 AND "completed" = true',
        [receipt.operationId],
      );
      expect(custody.rows[0].count).toBe("1");
    });
  },
);
