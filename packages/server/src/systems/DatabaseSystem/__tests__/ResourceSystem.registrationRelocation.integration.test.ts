import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CollisionFlag,
  DataManager,
  getExternalResources,
  ResourceSystem,
  World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ALL_WORLD_AREAS } from "../../../../../shared/src/data/world-areas";
import { ResourceEntity } from "../../../../../shared/src/entities/world/ResourceEntity";
import { EntityManager } from "../../../../../shared/src/systems/shared/entities/EntityManager";
import { TerrainSystem } from "../../../../../shared/src/systems/shared/world/TerrainSystem";
import type { Resource } from "../../../../../shared/src/types/core/core";
import type { TerrainResourceSpawnBatch } from "../../../../../shared/src/types/world/terrain";
import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import { DatabaseSystem } from "../index.js";

// Isolated PostgreSQL only. The supplied database is never modified: this test
// creates/drops a unique database and opens a genuinely new pool after shutdown.
// This is an actual CPU World/DatabaseSystem restart, not an OS server, client
// handshake, player gathering action, or browser/visual qualification.
const baseUrl =
  process.env.RESOURCE_REGISTRATION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseUrl ? describe.sequential : describe.skip;
const TICK_MS = 600;

// Actual pre-relocation world-areas.json points. Their old coordinate-derived
// IDs remain custody keys; the destination is read from the current real
// admitted manifest rather than duplicated as another placement table.
const LEGACY_TREES = [
  { id: "tree_367_311", subType: "general", x: 366, z: 310 },
  { id: "tree_373_313", subType: "oak", x: 372, z: 312 },
  { id: "tree_379_311", subType: "maple", x: 378, z: 310 },
  { id: "tree_379_304", subType: "mahogany", x: 378, z: 303 },
  { id: "tree_375_299", subType: "magic", x: 374, z: 298 },
] as const;
const IDS = LEGACY_TREES.map(({ id }) => id);

class RestartWorld extends World {
  pgPool!: pg.Pool;
  drizzleDb!: ReturnType<typeof drizzle<typeof schema>>;
  override get isServer(): boolean {
    return true;
  }
}

type ResourceInternals = {
  registerTerrainResources(batch: TerrainResourceSpawnBatch): Promise<void>;
  initializeWorldAreaResources(): Promise<void>;
  resources: Map<string, Resource>;
  respawnAtTick: Map<string, number>;
  terrainResourceLeases: Map<string, unknown>;
  terrainResourceRegistrations: Map<string, unknown>;
};

type WorldOwner = {
  world: RestartWorld;
  pool: pg.Pool;
  database: DatabaseSystem;
  manager: EntityManager;
  terrain: TerrainSystem;
  resources: ResourceInternals;
  applicationName: string;
  closed: boolean;
};

const sortStates = <T extends { resourceId: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.resourceId.localeCompare(b.resourceId));

function gameplayFields(entity: ResourceEntity) {
  const data = entity.getNetworkData();
  return Object.fromEntries(
    [
      "resourceId",
      "resourceType",
      "model",
      "modelScale",
      "depletedModelPath",
      "depletedModelScale",
      "harvestSkill",
      "requiredLevel",
      "harvestTime",
      "harvestYield",
      "respawnTime",
      "procgenPreset",
      "modelVariants",
    ].map((key) => [key, structuredClone(data[key])]),
  );
}

describeDatabase(
  "authored tree relocation with real PostgreSQL restart",
  () => {
    let admin: pg.Pool;
    let databaseName: string;
    let databaseUrl: string;
    const owners: WorldOwner[] = [];

    beforeAll(async () => {
      await DataManager.getInstance().initialize();
      databaseName = `hyperia_resource_move_${process.pid}_${Date.now().toString(36)}`;
      const url = new URL(baseUrl);
      url.pathname = "/postgres";
      admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      databaseUrl = url.toString();
      const migrationPool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
      });
      try {
        const connection = await migrationPool.connect();
        try {
          await migrate(createPostgresClientDatabase(connection), {
            migrationsFolder: path.resolve(
              import.meta.dirname,
              "../../../database/migrations",
            ),
          });
        } finally {
          connection.release();
        }
        const db = drizzle(migrationPool, { schema });
        await db.insert(schema.users).values({
          id: "resource-move-account",
          name: "Resource Move Test",
          roles: "user",
          createdAt: "2026-09-11T00:00:00.000Z",
        });
        await db.insert(schema.characters).values({
          id: "resource-move-player",
          accountId: "resource-move-account",
          name: "Resource Move Test",
        });
      } finally {
        await migrationPool.end();
      }
    }, 30_000);

    async function close(owner: WorldOwner): Promise<void> {
      if (owner.closed) return;
      owner.closed = true;
      try {
        owner.world.destroy();
      } finally {
        await owner.pool.end();
      }
    }

    afterEach(async () => {
      await Promise.all(owners.map(close));
    });

    afterAll(async () => {
      if (!admin) return;
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
          [databaseName],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }, 30_000);

    async function createWorld(generation: string): Promise<WorldOwner> {
      const applicationName = `${databaseName}_${generation}`;
      const pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 4,
        application_name: applicationName,
        statement_timeout: 15_000,
      });
      const world = new RestartWorld();
      world.pgPool = pool;
      world.drizzleDb = drizzle(pool, { schema });
      const database = world.register(
        "database",
        DatabaseSystem,
      ) as DatabaseSystem;
      // Server Vitest aliases package imports to the same source World; the
      // constructor adaptation only bridges source/build protected TS brands for
      // classes which are not public package exports. No class is replaced.
      const manager = world.register(
        "entity-manager",
        EntityManager as unknown as Parameters<World["register"]>[1],
      ) as unknown as EntityManager;
      const terrain = world.register(
        "terrain",
        TerrainSystem as unknown as Parameters<World["register"]>[1],
      ) as unknown as TerrainSystem;
      const system = world.register(
        "resource",
        ResourceSystem,
      ) as ResourceSystem;
      const owner: WorldOwner = {
        world,
        pool,
        database,
        manager,
        terrain,
        resources: system as unknown as ResourceInternals,
        applicationName,
        closed: false,
      };
      owners.push(owner);
      await database.init();
      await terrain.init();
      // Terrain.start normally installs these before resources start. Keep this
      // bounded CPU fixture on the real authored surface without starting tiles.
      const authoredTerrain = terrain as unknown as {
        loadWaterBodiesFromManifest(): void;
        loadFlatZonesFromManifest(): void;
      };
      authoredTerrain.loadWaterBodiesFromManifest();
      authoredTerrain.loadFlatZonesFromManifest();
      return owner;
    }

    async function commitDepletion(
      database: DatabaseSystem,
      resourceId: string,
    ) {
      const tree = LEGACY_TREES.find((row) => row.id === resourceId);
      const definition = getExternalResources().get(`tree_${tree?.subType}`);
      const drop = definition?.harvestYield[0];
      if (!definition || !drop)
        throw new Error("Missing actual tree reward data");
      const input = {
        playerId: "resource-move-player",
        resourceId,
        depleteAfterCommit: true,
        respawnTicks: definition.respawnTicks,
        skill: "woodcutting" as const,
        xpAmount: drop.xpAmount,
        reward: {
          itemId: drop.itemId,
          quantity: drop.quantity,
          stackable: drop.stackable ?? false,
        },
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

    it("retains all five original custody keys/deadlines at relocated authored positions across fresh worlds and pools", async () => {
      const destinationTrees = Object.values(ALL_WORLD_AREAS)
        .flatMap((area) => area.resources)
        .filter((resource) => resource.type === "tree");
      expect(destinationTrees).toHaveLength(5);
      expect(destinationTrees.map((tree) => tree.instanceId).sort()).toEqual(
        [...IDS].sort(),
      );
      const before = await createWorld("before");
      const receipts = await Promise.all(
        IDS.map((id) => commitDepletion(before.database, id)),
      );
      expect(receipts.every((receipt) => !receipt.replayed)).toBe(true);
      const durable = sortStates(
        await before.database.getGatheringResourceStatesAsync(IDS),
      );
      expect(durable).toHaveLength(5);
      for (const receipt of receipts) {
        expect(
          durable.find((row) => row.resourceId === receipt.resourceId),
        ).toMatchObject({
          operationId: receipt.operationId,
          respawnAt: receipt.depletedUntil,
        });
      }
      before.world.currentTick = 1000;
      // Legacy placements intentionally omit instanceId and use the real former
      // coordinate identity derivation, not a pre-seeded in-memory resource map.
      await before.resources.registerTerrainResources({
        isManifest: true,
        spawnPoints: LEGACY_TREES.map((tree) => ({
          type: "tree",
          subType: tree.subType,
          position: { x: tree.x, y: 0, z: tree.z },
        })),
      });
      const oldEntities = new Map<string, ResourceEntity>();
      const oldGameplay = new Map<string, ReturnType<typeof gameplayFields>>();
      const oldRemaining = new Map<string, number>();
      for (const tree of LEGACY_TREES) {
        const entity = before.manager.getEntity(tree.id);
        expect(entity).toBeInstanceOf(ResourceEntity);
        if (!(entity instanceof ResourceEntity))
          throw new Error("Missing old resource");
        oldEntities.set(tree.id, entity);
        oldGameplay.set(tree.id, gameplayFields(entity));
        oldRemaining.set(
          tree.id,
          before.resources.respawnAtTick.get(tree.id)! -
            before.world.currentTick,
        );
        expect(entity.serialize()).toMatchObject({
          id: tree.id,
          depleted: true,
        });
        expect(entity.position.y).toBe(
          before.terrain.getResourceGroundHeight(tree.x + 0.5, tree.z + 0.5),
        );
        expect(
          before.world.collision.hasFlags(
            tree.x,
            tree.z,
            CollisionFlag.BLOCKED,
          ),
        ).toBe(true);
      }
      await close(before);
      expect(before.manager.getAllEntities().size).toBe(0);
      expect(before.resources.resources.size).toBe(0);
      expect(before.resources.respawnAtTick.size).toBe(0);
      expect(before.resources.terrainResourceRegistrations.size).toBe(0);
      for (const tree of LEGACY_TREES) {
        expect(before.world.entities.get(tree.id)).toBeNull();
        expect(
          before.world.collision.hasFlags(
            tree.x,
            tree.z,
            CollisionFlag.BLOCKED,
          ),
        ).toBe(false);
      }
      const oldConnections = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND application_name = $2",
        [databaseName, before.applicationName],
      );
      expect(oldConnections.rows[0].count).toBe("0");
      await delay(2 * TICK_MS + 50);

      const after = await createWorld("after");
      expect(after.pool).not.toBe(before.pool);
      expect(after.database).not.toBe(before.database);
      expect(after.world).not.toBe(before.world);
      after.world.currentTick = 0;
      const hydrationStart = Date.now();
      // Exercise the actual world-areas producer/instanceId forwarding, not only
      // the lower-level registration helper. Other authored resources remain real.
      await after.resources.initializeWorldAreaResources();
      const hydrationEnd = Date.now();
      expect(
        sortStates(await after.database.getGatheringResourceStatesAsync(IDS)),
      ).toEqual(durable);
      expect(
        [...after.resources.resources.values()].filter(
          (resource) => resource.type === "tree",
        ),
      ).toHaveLength(5);
      for (const tree of LEGACY_TREES) {
        const destination = destinationTrees.find(
          (row) => row.instanceId === tree.id,
        )!;
        expect(destination.resourceId).toBe(`tree_${tree.subType}`);
        const x = Math.floor(destination.position.x) + 0.5;
        const z = Math.floor(destination.position.z) + 0.5;
        expect([x, z]).not.toEqual([tree.x + 0.5, tree.z + 0.5]);
        const entity = after.manager.getEntity(tree.id);
        expect(entity).toBeInstanceOf(ResourceEntity);
        if (!(entity instanceof ResourceEntity))
          throw new Error("Missing relocated resource");
        expect(entity).not.toBe(oldEntities.get(tree.id));
        expect(entity.position.toArray()).toEqual([
          x,
          after.terrain.getResourceGroundHeight(x, z),
          z,
        ]);
        expect(entity.serialize()).toMatchObject({
          id: tree.id,
          depleted: true,
        });
        expect(gameplayFields(entity)).toEqual(oldGameplay.get(tree.id));
        expect(
          after.world.collision.hasFlags(tree.x, tree.z, CollisionFlag.BLOCKED),
        ).toBe(false);
        expect(
          after.world.collision.hasFlags(
            Math.floor(x),
            Math.floor(z),
            CollisionFlag.BLOCKED,
          ),
        ).toBe(true);
        const state = durable.find((row) => row.resourceId === tree.id)!;
        expect(after.resources.resources.get(tree.id)).toMatchObject({
          isAvailable: false,
          lastDepleted: state.depletedAt,
        });
        const remaining = after.resources.respawnAtTick.get(tree.id)!;
        expect(remaining).toBeLessThan(oldRemaining.get(tree.id)!);
        expect(remaining).toBeGreaterThanOrEqual(
          Math.ceil((state.respawnAt - hydrationEnd) / TICK_MS),
        );
        expect(remaining).toBeLessThanOrEqual(
          Math.ceil((state.respawnAt - hydrationStart) / TICK_MS),
        );
        // Restart migration is allowed; moving that same live identity again is not.
        await expect(
          after.resources.registerTerrainResources({
            isManifest: true,
            spawnPoints: [
              {
                instanceId: tree.id,
                type: "tree",
                subType: tree.subType,
                position: { x: tree.x, y: 0, z: tree.z },
              },
            ],
          }),
        ).rejects.toThrow("Conflicting registration");
        expect(after.manager.getEntity(tree.id)).toBe(entity);
        expect(after.resources.respawnAtTick.get(tree.id)).toBe(remaining);
      }
      expect(
        sortStates(await after.database.getGatheringResourceStatesAsync(IDS)),
      ).toEqual(durable);
      const custody = await after.pool.query<{
        resource_id: string;
        count: string;
      }>(
        `SELECT resource_id, count(*)::text AS count
       FROM gathering_resource_states WHERE resource_id = ANY($1::text[])
       GROUP BY resource_id ORDER BY resource_id`,
        [IDS],
      );
      expect(custody.rows).toEqual(
        [...IDS].sort().map((resource_id) => ({ resource_id, count: "1" })),
      );
    }, 30_000);
  },
);
