import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import {
  World,
  DataManager,
  ResourceSystem,
  Socket,
  readPacket,
} from "@hyperforge/shared";
import { EntityManager } from "../../../../../shared/src/systems/shared/entities/EntityManager";
import { ResourceEntity } from "../../../../../shared/src/entities/world/ResourceEntity";
import { TerrainSystem } from "../../../../../shared/src/systems/shared/world/TerrainSystem";
import { RoadNetworkSystem } from "../../../../../shared/src/systems/shared/world/RoadNetworkSystem";
import groveLayouts from "../../../../../shared/src/systems/shared/world/__tests__/fixtures/CompactResourceGroves.layouts.json";
import type { TerrainResourceSpawnBatch } from "../../../../../shared/src/types/world/terrain";
import type { Resource } from "../../../../../shared/src/types/core/core";
import { ConnectionHandler } from "../connection-handler";
import { BroadcastManager } from "../broadcast";
import { ServerNetwork } from "../index";
import { createDrizzleAdapter } from "../../../database/adapter";
import * as schema from "../../../database/schema";
import type { NodeWebSocket, ServerSocket } from "../../../shared/types";

class CpuServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}

describe("resource snapshot delivery on a real unregistered socket", () => {
  it.each([false, true])(
    "sends exact authoritative availability before socket-map registration without changing 110m entity relevance (full 48-tree core: %s)",
    async (fullCore) => {
      await DataManager.getInstance().initialize();
      const world = new CpuServerWorld();
      // Server Vitest resolves @hyperforge/shared to this same source graph;
      // bridge only source/build protected TS brands for the unexported class.
      const manager = world.register(
        "entity-manager",
        EntityManager as unknown as Parameters<World["register"]>[1],
      ) as unknown as EntityManager;
      const resources = world.register(
        "resource",
        ResourceSystem,
      ) as ResourceSystem;
      const internals = resources as unknown as {
        registerTerrainResources(
          batch: TerrainResourceSpawnBatch,
        ): Promise<void>;
        resources: Map<string, Resource>;
        terrainResourceTails: Map<string, Promise<void>>;
        initializeWorldAreaResources(): Promise<void>;
      };
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const listening = once(wss, "listening");
      // Real unused database adapter satisfies the connection constructor. This
      // test executes no SQL, authentication, migrations or persistence stand-in.
      const pool = new Pool({ host: "127.0.0.1", port: 1, max: 1 });
      const db = createDrizzleAdapter(drizzle(pool, { schema }));
      let client: WebSocket | undefined;
      let peer: WebSocket | undefined;
      let socket: Socket | undefined;
      try {
        if (fullCore) {
          const terrain = world.register(
            "terrain",
            TerrainSystem as unknown as Parameters<World["register"]>[1],
          ) as unknown as TerrainSystem;
          const roads = world.register(
            "roads",
            RoadNetworkSystem as unknown as Parameters<World["register"]>[1],
          ) as unknown as RoadNetworkSystem;
          await terrain.init();
          const t = terrain as unknown as {
            loadWaterBodiesFromManifest(): void;
            loadFlatZonesFromManifest(): void;
          };
          t.loadWaterBodiesFromManifest();
          t.loadFlatZonesFromManifest();
          await roads.init();
          await roads.start();
          await resources.init();
          await terrain.start();
          await Promise.all([...internals.terrainResourceTails.values()]);
          await internals.initializeWorldAreaResources();
          await Promise.all([...internals.terrainResourceTails.values()]);
          expect(
            resources
              .getAllResources()
              .filter((r) => r.type === "tree")
              .map((r) => r.id)
              .sort(),
          ).toEqual(
            [
              "tree_281_513",
              "tree_281_518",
              "tree_289_508",
              "tree_311_295",
              "tree_335_266",
              "tree_367_311",
              "tree_373_313",
              "tree_375_299",
              "tree_377_288",
              "tree_379_304",
              "tree_379_311",
              "tree_502_419",
              "tree_503_432",
              ...groveLayouts.previous.regions.flatMap((r) =>
                r.anchors.map((a) => a.id),
              ),
              ...groveLayouts.additions.map((a) => a.id),
            ].sort(),
          );
          expect(
            resources.getAllResources().filter((r) => r.type === "tree"),
          ).toHaveLength(48);
          expect(
            resources
              .getAllResources()
              .filter((r) => r.type !== "tree")
              .map((r) => r.id)
              .sort(),
          ).toEqual([
            "fish_341_308",
            "ore_337_345",
            "ore_341_348",
            "ore_345_345",
            "ore_353_347",
            "ore_357_345",
            "ore_361_348",
            "ore_365_345",
            "ore_367_297",
            "ore_371_298",
            "ore_375_297",
          ]);
          expect(
            [...terrain.getTiles().values()].filter(
              (tile) => tile.contentGenerated,
            ),
          ).toHaveLength(9);
        } else
          await internals.registerTerrainResources({
            owner: { tileX: 3, tileZ: 5 },
            spawnPoints: [
              {
                id: "2_4_tree_0",
                type: "tree",
                subType: "banana",
                position: { x: 288.5, y: 30.5, z: 507.5 },
                scale: 1.15,
                rotation: 0.37,
              },
              {
                id: "2_5_tree_1",
                type: "tree",
                subType: "palm",
                position: { x: 280.5, y: 21.8, z: 517.5 },
                scale: 1.05,
                rotation: 0.5,
              },
            ],
          });
        const depleted = internals.resources.get(
          fullCore ? "tree_337_488" : "tree_289_508",
        )!;
        depleted.isAvailable = false;
        depleted.lastDepleted = 1000;
        const entity = manager.getEntity(depleted.id);
        expect(entity).toBeInstanceOf(ResourceEntity);
        if (!(entity instanceof ResourceEntity))
          throw new Error("Missing real resource");
        expect(entity.config.modelScale).toBe(fullCore ? 0.8 : 1.15);
        entity.deplete();
        await listening;
        const address = wss.address();
        if (!address || typeof address === "string")
          throw new Error("Missing native socket address");
        const accepted = once(wss, "connection");
        client = new WebSocket(`ws://127.0.0.1:${address.port}`);
        [peer] = (await accepted) as [WebSocket];
        if (client.readyState !== WebSocket.OPEN) await once(client, "open");
        const network = new ServerNetwork(world);
        // Socket's shared declaration uses the DOM-compatible NodeWebSocket shape;
        // the value here is the actual accepted ws socket, not a substituted API.
        socket = new Socket({
          id: "native-resource-snapshot",
          ws: peer as unknown as NodeWebSocket,
          network,
        });
        const sockets = new Map<string, ServerSocket>();
        const broadcast = new BroadcastManager(sockets);
        const handler = new ConnectionHandler(world, sockets, broadcast, db);
        const send = handler as unknown as {
          sendResourceSnapshot(target: ServerSocket): Promise<void>;
          shouldIncludeSpectatorEntity(
            entity: unknown,
            follow: undefined,
            participants: Set<string>,
            position: { x: number; z: number },
            radiusSquared: number,
          ): boolean;
        };
        expect(
          send.shouldIncludeSpectatorEntity(
            entity,
            undefined,
            new Set(),
            { x: 384.5, z: 374.5 },
            110 * 110,
          ),
        ).toBe(false);
        expect(sockets.size).toBe(0);
        // Demonstrate why a pre-registration BroadcastManager lookup cannot send.
        expect(
          broadcast.sendToSocket(socket.id, "resourceSnapshot", {
            resources: [],
          }),
        ).toBe(false);
        const received = once(client, "message", {
          signal: AbortSignal.timeout(3000),
        });
        await send.sendResourceSnapshot(socket as ServerSocket);
        const [wire, binary] = await received;
        expect(binary).toBe(true);
        expect(Buffer.isBuffer(wire)).toBe(true);
        const packet = readPacket(wire as Buffer);
        expect(packet?.[0]).toBe("onResourceSnapshot");
        expect(packet?.[1]).toEqual({
          resources: resources.getAllResources().map((row) => ({
            id: row.id,
            type: row.type,
            position: row.position,
            isAvailable: row.isAvailable,
            respawnAt:
              !row.isAvailable && row.lastDepleted && row.respawnTime
                ? row.lastDepleted + row.respawnTime
                : undefined,
          })),
        });
        expect(sockets.size).toBe(0);
        expect(pool.totalCount).toBe(0);
        expect(depleted.isAvailable).toBe(false);
        expect(depleted.lastDepleted).toBe(1000);
      } finally {
        // This deliberately uninitialized ServerNetwork has no connection manager;
        // detach the real Socket's owned listeners before closing the native pair.
        if (socket) (socket as unknown as { cleanup(): void }).cleanup();
        client?.terminate();
        peer?.terminate();
        await new Promise<void>((resolve, reject) =>
          wss.close((error) => (error ? reject(error) : resolve())),
        );
        world.destroy();
        await pool.end();
      }
    },
  );
});
