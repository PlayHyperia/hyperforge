/**
 * Bank Validation Integration Tests
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DataManager,
  World,
  PlayerEntity,
  NPCEntity,
  TerrainSystem,
  SessionType,
  Socket,
  readPacket,
  loadPhysX,
  getNPCById,
  EventType,
} from "@hyperforge/shared";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { ALL_NPCS } from "../../../../shared/src/data/npcs";
import { ALL_WORLD_AREAS } from "../../../../shared/src/data/world-areas";
import { EntityManager } from "../../../../shared/src/systems/shared/entities/EntityManager";
import { MobNPCSpawnerSystem } from "../../../../shared/src/systems/shared/entities/MobNPCSpawnerSystem";
import { BankEntity } from "../../../../shared/src/entities/world/BankEntity";
import {
  EntityType,
  NPCType,
} from "../../../../shared/src/types/entities/entities";
import { validatePhysicalBankAccess } from "../../../src/shared/PhysicalBankAccess";
import { BroadcastManager } from "../../../src/systems/ServerNetwork/broadcast";
import { InteractionSessionManager } from "../../../src/systems/ServerNetwork/InteractionSessionManager";
import { ServerNetwork } from "../../../src/systems/ServerNetwork";
import { TickSystem } from "../../../src/systems/TickSystem";
import type { NodeWebSocket, ServerSocket } from "../../../src/shared/types";
import {
  handleBankDeposit,
  handleBankWithdraw,
} from "../../../src/systems/ServerNetwork/handlers/bank/core";
import { RateLimitService } from "../../../src/systems/ServerNetwork/services";
import { validateTransactionRequest } from "../../../src/systems/ServerNetwork/handlers/common";

class BankServerWorld extends World {
  override get isServer() {
    return true;
  }
  override get isClient() {
    return false;
  }
  interactionSessionManager!: InteractionSessionManager;
}

describe("authoritative physical bank clerk access", () => {
  const releases: Array<() => Promise<void> | void> = [];
  let nextPlayer = 0;
  beforeAll(async () => {
    await DataManager.getInstance().initialize();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await loadPhysX();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  afterEach(async () => {
    for (const release of releases.splice(0).reverse()) await release();
  });

  async function fixture() {
    const world = new BankServerWorld();
    releases.push(() => world.destroy());
    await world.physics.init();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    const entities = world.register(
      "entity-manager",
      EntityManager,
    ) as EntityManager;
    await entities.init();
    const spawner = world.register(
      "mob-npc-spawner",
      MobNPCSpawnerSystem,
    ) as MobNPCSpawnerSystem;
    await spawner.init();
    await spawner["spawnAllNPCsFromManifest"]();
    const clerks = entities
      .getEntitiesByType("npc")
      .filter(
        (entity): entity is NPCEntity =>
          entity instanceof NPCEntity && entity.config.npcType === "bank",
      );
    const bankPlacements = Object.values(ALL_WORLD_AREAS)
      .flatMap((area) => area.npcs)
      .filter((npc) => npc.type === "bank");
    expect(bankPlacements.length).toBeGreaterThan(0);
    expect(clerks).toHaveLength(bankPlacements.length);
    const player = new PlayerEntity(world, {
      id: `bank-auth-${++nextPlayer}`,
      name: "Bank authorization",
      type: "player",
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
    });
    world.entities.set(player.id, player);
    const near = (target = clerks[0], dx = 1, dz = 1) =>
      player.position.set(
        target.position.x + dx,
        target.position.y,
        target.position.z + dz,
      );
    near();
    const access = (id = clerks[0].id) =>
      validatePhysicalBankAccess(world, player.id, id);
    return { world, entities, clerks, player, near, access };
  }

  async function sessionFixture() {
    const f = await fixture();
    // Real binary Socket over an ephemeral loopback connection. No game server,
    // fake socket, database or production service is started by this fixture.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing loopback port");
    const connection = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const packets: Array<{ method: string; data: unknown }> = [];
    client.on("message", (bytes) => {
      const packet = readPacket(new Uint8Array(bytes as Buffer));
      if (packet.length) packets.push({ method: packet[0], data: packet[1] });
    });
    await once(client, "open");
    const [peer] = (await connection) as [WebSocket];
    const network = new ServerNetwork(f.world);
    const socket = new Socket({
      id: "bank-auth-socket",
      ws: peer as unknown as NodeWebSocket,
      network,
      player: f.player,
    }) as ServerSocket;
    network.sockets.set(socket.id, socket);
    const broadcast = new BroadcastManager(network.sockets);
    const sessions = new InteractionSessionManager(f.world, broadcast);
    sessions.initialize(new TickSystem());
    f.world.interactionSessionManager = sessions;
    releases.push(async () => {
      sessions.destroy();
      // This fixture owns transport only, not uninitialized ServerNetwork's
      // disconnect managers. Release actual Socket listeners before closing it.
      socket["cleanup"]();
      peer.terminate();
      client.terminate();
      network.sockets.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const open = (type: SessionType = SessionType.BANK) =>
      sessions.openSession({
        playerId: f.player.id,
        socketId: socket.id,
        sessionType: type,
        targetEntityId: f.clerks[0].id,
      });
    return { ...f, socket, sessions, packets, open };
  }

  it("admits every live manifest clerk by hashed authoritative ID, not a nearby chest", async () => {
    const f = await fixture();
    for (const clerk of f.clerks) {
      expect(clerk.id).toMatch(/^npc_.+_[a-f0-9]{40}$/);
      expect(clerk.config.services).toContain("bank");
      expect(getNPCById(clerk.config.npcId)?.services.types).toContain("bank");
      f.near(clerk);
      expect(f.access(clerk.id)).toBeNull();
    }
  });

  it("preserves real BankEntity chest access and the exact two-tile Chebyshev boundary", async () => {
    const f = await fixture();
    const bank = await f.entities.spawnEntity({
      id: "physical-bank-chest",
      name: "Bank",
      type: EntityType.BANK,
      position: { x: 20, y: 7, z: 30 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: null,
      interactionDistance: 2,
      description: "Authoritative bank chest",
      model: null,
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: 1, max: 1 },
        level: 1,
      },
    });
    expect(bank).toBeInstanceOf(BankEntity);
    for (const target of [bank!, ...f.clerks]) {
      f.player.position.set(
        target.position.x + 2,
        target.position.y,
        target.position.z - 2,
      );
      expect(f.access(target.id)).toBeNull();
      f.player.position.x += 0.000001;
      expect(f.access(target.id)).toBe("bank_out_of_range");
    }
  });

  it.each([
    "role",
    "services",
    "manifest",
    "manifest-services",
    "manifest-disabled",
    "destroyed",
    "removed",
    "stale-owner",
  ] as const)("rejects an invalid clerk: %s", async (kind) => {
    const f = await fixture(),
      clerk = f.clerks[0];
    const manifest = getNPCById(clerk.config.npcId)!;
    if (kind === "role") clerk.config.npcType = NPCType.QUEST_GIVER;
    if (kind === "services") clerk.config.services = [];
    if (kind === "manifest") clerk.config.npcId = "not-a-loaded-npc";
    if (kind === "manifest-services" || kind === "manifest-disabled") {
      ALL_NPCS.set(manifest.id, {
        ...manifest,
        services: {
          ...manifest.services,
          ...(kind === "manifest-services"
            ? { types: [] }
            : { enabled: false }),
        },
      });
      releases.push(() => {
        ALL_NPCS.set(manifest.id, manifest);
      });
    }
    if (kind === "destroyed") clerk.destroy();
    if (kind === "removed") f.entities.destroyEntity(clerk.id);
    if (kind === "stale-owner") {
      const stale = new NPCEntity(f.world, structuredClone(clerk.config));
      f.world.entities.set(clerk.id, stale);
      releases.push(() => stale.destroy());
    }
    expect(f.access()).toBe("bank_target_invalid");
  });

  it("rejects client-facing bank labels/services on a generic live NPC and a different-world owner", async () => {
    const f = await fixture();
    const npc = f.entities
      .getEntitiesByType("npc")
      .find(
        (entity) =>
          entity instanceof NPCEntity &&
          !entity.config.services.includes("bank"),
      )! as NPCEntity;
    npc.data.name = "Bank";
    Object.assign(npc.data, { services: ["bank"], entityType: "bank" });
    f.near(npc);
    expect(f.access(npc.id)).toBe("bank_target_invalid");
    const foreign = await fixture();
    const other = foreign.clerks[0];
    f.world.entities.set(other.id, other);
    f.near(other);
    expect(f.access(other.id)).toBe("bank_target_invalid");
  });

  it.each(["player-x", "player-y", "target-z", "target-y"])(
    "rejects nonfinite authoritative positions: %s",
    async (part) => {
      const f = await fixture();
      if (part === "player-x") f.player.position.x = NaN;
      if (part === "player-y") f.player.position.y = Infinity;
      if (part === "target-z") f.clerks[0].position.z = NaN;
      if (part === "target-y") f.clerks[0].position.y = Infinity;
      expect(f.access()).toBe("bank_target_invalid");
    },
  );

  it("denies missing players and duel-locked players", async () => {
    const f = await fixture();
    f.player.data.inStreamingDuel = true;
    expect(f.access()).toBe("duel_locked");
    f.world.entities.remove(f.player.id);
    expect(f.access()).toBe("player_unavailable");
  });

  for (const operation of ["deposit", "withdraw"] as const) {
    it.each([
      "distance",
      "removed",
      "destroyed",
      "role",
      "services",
      "duel",
      "stale-owner",
    ] as const)(
      `${operation} revalidates and closes a previously opened clerk session after %s`,
      async (reason) => {
        const f = await sessionFixture();
        expect(f.access()).toBeNull();
        f.open();
        expect(f.sessions.getSession(f.player.id)?.targetEntityId).toBe(
          f.clerks[0].id,
        );
        if (reason === "distance") f.player.position.x += 10;
        if (reason === "removed") f.entities.destroyEntity(f.clerks[0].id);
        if (reason === "destroyed") f.clerks[0].destroy();
        if (reason === "role") f.clerks[0].config.npcType = NPCType.QUEST_GIVER;
        if (reason === "services") f.clerks[0].config.services = [];
        if (reason === "duel") f.player.data.inStreamingDuel = true;
        if (reason === "stale-owner") {
          const stale = new NPCEntity(
            f.world,
            structuredClone(f.clerks[0].config),
          );
          f.world.entities.set(stale.id, stale);
          releases.push(() => stale.destroy());
        }
        const handler =
          operation === "deposit" ? handleBankDeposit : handleBankWithdraw;
        await handler(f.socket, { itemId: "logs", quantity: 1 }, f.world);
        expect(f.sessions.getSession(f.player.id)).toBeUndefined();
        const deadline = performance.now() + 1000;
        while (
          !f.packets.some((p) => p.method === "onShowToast") &&
          performance.now() < deadline
        )
          await delay(5);
        expect(f.packets.some((p) => p.method === "onBankClose")).toBe(true);
        expect(f.packets.find((p) => p.method === "onShowToast")?.data).toEqual(
          {
            message:
              reason === "distance"
                ? "You are too far from the bank"
                : reason === "duel"
                  ? "You can't use a bank during a duel."
                  : "Target no longer exists",
            type: "error",
          },
        );
        expect(f.packets.some((p) => p.method === "onBankState")).toBe(false);
      },
    );
  }

  it.each([SessionType.DIALOGUE, SessionType.STORE])(
    "does not authorize bank mutation through an existing %s session",
    async (type) => {
      const f = await sessionFixture();
      f.open(type);
      const result = validateTransactionRequest(
        f.socket,
        f.world,
        SessionType.BANK,
        new RateLimitService(),
      );
      expect(result).toEqual({ success: false, error: "DISTANCE_INVALID" });
      expect(f.sessions.getSession(f.player.id)?.sessionType).toBe(type);
    },
  );

  it("rejects an unauthenticated real socket before banking", async () => {
    const f = await sessionFixture();
    f.socket.player = undefined;
    expect(
      validateTransactionRequest(
        f.socket,
        f.world,
        SessionType.BANK,
        new RateLimitService(),
      ),
    ).toEqual({ success: false, error: "PLAYER_NOT_FOUND" });
  });

  it("accepts actual BANK_OPEN event sessions for every clerk through the database boundary", async () => {
    const f = await sessionFixture();
    for (const clerk of f.clerks) {
      f.near(clerk);
      // The exact event emitted by handleBankOpen after its database read. This
      // qualifies event/session authority, not a successful DB transaction.
      f.world.emit(EventType.BANK_OPEN, {
        playerId: f.player.id,
        bankId: clerk.id,
        bankEntityId: clerk.id,
      });
      expect(f.sessions.getSession(f.player.id)).toMatchObject({
        sessionType: SessionType.BANK,
        targetEntityId: clerk.id,
      });
      expect(
        validateTransactionRequest(
          f.socket,
          f.world,
          SessionType.BANK,
          new RateLimitService(),
        ),
      ).toEqual({ success: false, error: "DB_UNAVAILABLE" });
      expect(f.sessions.getSession(f.player.id)?.targetEntityId).toBe(clerk.id);
    }
  });
});
