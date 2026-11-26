import { once } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  DataManager,
  DuelErrorCode,
  PlayerEntity,
  Socket,
  World,
  readPacket,
  type NodeWebSocket,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../../shared/types";
import { ServerNetwork } from "../../ServerNetwork";
import { PendingDuelChallengeManager } from "../../ServerNetwork/PendingDuelChallengeManager";
import { TileMovementManager } from "../../ServerNetwork/tile-movement";
import { handleDuelChallenge } from "../../ServerNetwork/handlers/duel/challenge";
import { DuelSystem } from "../index";
import { DUEL_ERRORS } from "../error-messages";
import { STREAMING_DUEL_ARENA_RESERVATION_ID } from "../streaming-arena";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

function createFixture() {
  const world = new World();
  const duel = new DuelSystem(world);
  Object.assign(world, { duelSystem: duel });
  return { world, duel };
}

function challenge(duel: DuelSystem) {
  return duel.createChallenge(
    "challenger",
    "Challenger",
    "socket",
    3,
    "target",
    "Target",
  );
}

const noCapacity = {
  success: false,
  error: DUEL_ERRORS.NO_ARENA_AVAILABLE,
  errorCode: DuelErrorCode.NO_ARENA_AVAILABLE,
};

describe("single-arena ordinary challenge admission", () => {
  it("rechecks capacity before creating pending state after a delayed challenge", () => {
    const { duel } = createFixture();
    try {
      expect(duel.arenaPool.getAvailableCount()).toBe(1);
      expect(
        duel.arenaPool.reserveSpecificArena(
          1,
          STREAMING_DUEL_ARENA_RESERVATION_ID,
        ),
      ).toBe(true);
      expect(challenge(duel)).toEqual(noCapacity);
      expect(duel.pendingDuels.hasAnyChallenge("challenger")).toBe(false);
      expect(duel.pendingDuels.hasAnyChallenge("target")).toBe(false);
      expect([...duel["sessionManager"].getAllSessions()]).toHaveLength(0);
      expect(duel.arenaPool.getDuelIdForArena(1)).toBe(
        STREAMING_DUEL_ARENA_RESERVATION_ID,
      );
    } finally {
      duel.destroy();
    }
  });

  it("retires an accepted invitation if the ring becomes occupied before setup", () => {
    const { duel } = createFixture();
    try {
      const invitation = challenge(duel);
      expect(invitation.success).toBe(true);
      expect(duel.arenaPool.reserveArena("other-duel")).toBe(1);
      expect(
        duel.respondToChallenge(invitation.challengeId!, "target", true),
      ).toEqual(noCapacity);
      expect(
        duel.pendingDuels.getChallenge(invitation.challengeId!),
      ).toBeUndefined();
      expect([...duel["sessionManager"].getAllSessions()]).toHaveLength(0);
      expect(duel.arenaPool.getDuelIdForArena(1)).toBe("other-duel");
    } finally {
      duel.destroy();
    }
  });

  it("retains the final atomic allocation check after setup", () => {
    const { duel } = createFixture();
    try {
      const invitation = challenge(duel);
      const accepted = duel.respondToChallenge(
        invitation.challengeId!,
        "target",
        true,
      );
      expect(accepted.success).toBe(true);
      const session = duel.getDuelSession(accepted.duelId!)!;
      // Exercise the public final-confirmation boundary, not simulated combat.
      session.state = "CONFIRMING";
      expect(duel.arenaPool.reserveArena("other-duel")).toBe(1);
      expect(duel.acceptFinal(session.duelId, "challenger").success).toBe(true);
      expect(duel.acceptFinal(session.duelId, "target")).toEqual(noCapacity);
      expect(session.arenaId).toBeNull();
      expect(session.state).toBe("CONFIRMING");
      expect(duel.arenaPool.getDuelIdForArena(1)).toBe("other-duel");
    } finally {
      duel.destroy();
    }
  });

  it("sends the actual busy packet before queueing walk-to-target on a real loopback socket", async () => {
    const { world, duel } = createFixture();
    const network = new ServerNetwork(world);
    const movement = new TileMovementManager(world, network.send.bind(network));
    const pending = new PendingDuelChallengeManager(world, movement);
    Object.assign(world, { pendingDuelChallengeManager: pending });
    const player = new PlayerEntity(world, {
      id: "single-arena-challenger",
      type: "player",
      name: "Challenger",
      position: [385, 28.819301523097685, 374],
      health: 10,
      maxHealth: 10,
      stamina: 100,
      maxStamina: 100,
    });
    const target = new PlayerEntity(world, {
      id: "single-arena-target",
      type: "player",
      name: "Target",
      position: [395, 28.819301523097685, 374],
      health: 10,
      maxHealth: 10,
      stamina: 100,
      maxStamina: 100,
    });
    // The shared map's legacy Player facade is wider than actual server entities.
    const players = world.entities.players as unknown as Map<
      string,
      PlayerEntity
    >;
    players.set(player.id, player);
    players.set(target.id, target);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let client: WebSocket | undefined;
    let peer: WebSocket | undefined;
    let socket: Socket | undefined;
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing loopback listener");
      const connected = once(server, "connection");
      client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(client, "open");
      [peer] = await connected;
      socket = new Socket({
        id: "single-arena-socket",
        ws: peer as unknown as NodeWebSocket,
        network,
        player,
      });
      expect(
        duel.arenaPool.reserveSpecificArena(
          1,
          STREAMING_DUEL_ARENA_RESERVATION_ID,
        ),
      ).toBe(true);
      const response = once(client, "message");
      const position = player.position.clone();
      handleDuelChallenge(
        socket as ServerSocket,
        { targetPlayerId: target.id },
        world,
      );
      const [bytes] = await response;
      expect(readPacket(new Uint8Array(bytes))).toEqual([
        "onDuelError",
        { message: DUEL_ERRORS.NO_ARENA_AVAILABLE, code: "NO_ARENA_AVAILABLE" },
      ]);
      expect(pending.hasPendingChallenge(player.id)).toBe(false);
      expect(duel.pendingDuels.hasAnyChallenge(player.id)).toBe(false);
      expect([...duel["sessionManager"].getAllSessions()]).toHaveLength(0);
      expect(player.position.equals(position)).toBe(true);
    } finally {
      // Detach the real wrapper's listeners before closing an unstarted network.
      socket?.["cleanup"]();
      peer?.terminate();
      client?.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      duel.destroy();
      player.destroy();
      target.destroy();
      world.entities.players.clear();
    }
  });
});
