import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { once } from "node:events";
import { WebSocketServer, WebSocket as Peer, type RawData } from "ws";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { loadPhysX } from "../../../physics/PhysXManager";
import { readPacket, writePacket } from "../../../platform/shared/packets";
import type { WorldOptions } from "../../../types";
import {
  EventType,
  type EntryRetryState,
  type EventMap,
} from "../../../types/events";
import type { WorldContentAdmission } from "../../../runtime/WorldContentAdmission";
import { ClientNetwork } from "../ClientNetwork";

type SelectionBoundary = {
  captureCharacterSelection(options: WorldOptions): void;
  selectedCharacterId: string | null | undefined;
  lastInitOptions: WorldOptions | null;
  worldAdmission: WorldContentAdmission;
  entryRetryTimer: ReturnType<typeof setTimeout> | null;
  isReconnecting: boolean;
  embeddedCharacterId: string | null;
};

// Exercise the real initialization boundary and native Storage when the host
// provides it (Node's --experimental-webstorage lane). No replaced methods,
// fake storage, timers, transport or authentication-success claims.
const tabStorage =
  typeof sessionStorage === "undefined" ? null : sessionStorage;
const initialSelection = tabStorage?.getItem("selectedCharacterId") ?? null;
const worlds: World[] = [];
const sockets: Array<{ server: WebSocketServer; peer?: Peer }> = [];

beforeAll(async () => {
  await DataManager.getInstance().initialize();
  if (process.env.NODE_OPTIONS?.includes("--experimental-webstorage")) {
    expect(tabStorage).not.toBeNull();
  }
  console.info(
    "Character selection host storage:",
    tabStorage ? "native" : "absent",
  );
});

function decode(bytes: RawData) {
  return readPacket(Array.isArray(bytes) ? Buffer.concat(bytes) : bytes);
}

afterEach(async () => {
  for (const world of worlds.splice(0)) world.destroy();
  for (const { server, peer } of sockets.splice(0)) {
    peer?.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (initialSelection === null) tabStorage?.removeItem("selectedCharacterId");
  else tabStorage?.setItem("selectedCharacterId", initialSelection);
});

function fixture() {
  const world = new World();
  worlds.push(world);
  const network = world.register("network", ClientNetwork) as ClientNetwork;
  const boundary = network as unknown as SelectionBoundary;
  return { world, network, boundary };
}

async function wireFixture(selectedCharacterId: string | null) {
  const f = fixture();
  f.boundary.captureCharacterSelection({ selectedCharacterId });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const owned: { server: WebSocketServer; peer?: Peer } = { server };
  sockets.push(owned);
  await once(server, "listening", { signal: AbortSignal.timeout(5000) });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing loopback port");
  const accepted = once(server, "connection", {
    signal: AbortSignal.timeout(5000),
  });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  client.binaryType = "arraybuffer";
  f.network.ws = client;
  client.addEventListener("message", f.network.onPacket);
  client.addEventListener("close", f.network.onClose);
  const [[peer]] = await Promise.all([
    accepted,
    once(client, "open", { signal: AbortSignal.timeout(5000) }),
  ]);
  if (!(peer instanceof Peer)) throw Error("Actual loopback peer required");
  owned.peer = peer;
  const packets: Array<[string, unknown]> = [];
  peer.on("message", (bytes) => {
    const decoded = decode(bytes);
    if (decoded?.[0]) packets.push([decoded[0], decoded[1]]);
  });
  f.boundary.worldAdmission.beginConnection();
  const snapshot = async (spectatorMode = false) => {
    const worldContentIdentity = DataManager.getWorldContentIdentity();
    if (!worldContentIdentity) throw Error("Real manifest identity required");
    const data = {
      id: "selection-boundary-client",
      worldContentIdentity,
      serverTime: performance.now(),
      entities: [],
      characters: [
        { id: "choice-a", name: "A" },
        { id: "choice-b", name: "B" },
      ],
      spectatorMode,
    };
    await f.network.onSnapshot(data);
  };
  const drain = async () => {
    const marker = packets.length + 1;
    const reached = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        peer.off("message", listener);
        peer.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(Error("Loopback packet drain timed out")),
        5000,
      );
      const closed = () => finish(Error("Loopback closed before packet drain"));
      const listener = (bytes: RawData) => {
        const packet = decode(bytes);
        if (packet?.[0] === "onKeepalive" && packet[1] === marker) {
          finish();
        }
      };
      peer.on("message", listener);
      peer.once("close", closed);
      try {
        f.network.send("keepalive", marker);
      } catch (error) {
        finish(error instanceof Error ? error : Error("Loopback send failed"));
      }
    });
    await reached;
    return packets.filter(([method]) => method !== "onKeepalive");
  };
  const deliver = async (name: string, data: unknown) => {
    const arrived = once(client, "message", {
      signal: AbortSignal.timeout(5000),
    });
    peer.send(writePacket(name, data));
    await arrived;
    f.network.flush();
  };
  return { ...f, client, peer, packets, snapshot, drain, deliver };
}

describe("stable explicit character intent in the actual ClientNetwork", () => {
  it("captures an explicit choice and clones its reconnect options", () => {
    tabStorage?.setItem("selectedCharacterId", "foreign-choice");
    const f = fixture();
    const options: WorldOptions = { selectedCharacterId: "choice-a" };
    f.boundary.captureCharacterSelection(options);
    options.selectedCharacterId = "choice-b";
    expect(f.boundary.selectedCharacterId).toBe("choice-a");
    expect(f.boundary.lastInitOptions?.selectedCharacterId).toBe("choice-a");
  });

  it("explicit null never falls back to a stored or previous choice", () => {
    tabStorage?.setItem("selectedCharacterId", "choice-b");
    const f = fixture();
    f.boundary.captureCharacterSelection({ selectedCharacterId: "choice-a" });
    f.boundary.captureCharacterSelection({ selectedCharacterId: null });
    f.boundary.captureCharacterSelection({});
    expect(f.boundary.selectedCharacterId).toBeNull();
    expect(f.boundary.lastInitOptions?.selectedCharacterId).toBeNull();
  });

  it("seeds an omitted choice once from the actual host storage boundary", () => {
    tabStorage?.setItem("selectedCharacterId", "choice-a");
    const f = fixture();
    f.boundary.captureCharacterSelection({});
    const expected = tabStorage ? "choice-a" : null;
    expect(f.boundary.selectedCharacterId).toBe(expected);
    tabStorage?.setItem("selectedCharacterId", "choice-b");
    f.boundary.captureCharacterSelection({});
    expect(f.boundary.selectedCharacterId).toBe(expected);
    f.boundary.captureCharacterSelection(f.boundary.lastInitOptions!);
    expect(f.boundary.selectedCharacterId).toBe(expected);
  });

  it("does not import a later choice after the initial seed was absent", () => {
    tabStorage?.removeItem("selectedCharacterId");
    const f = fixture();
    f.boundary.captureCharacterSelection({});
    tabStorage?.setItem("selectedCharacterId", "choice-b");
    f.boundary.captureCharacterSelection({});
    expect(f.boundary.selectedCharacterId).toBeNull();
  });

  it("allows a later explicit initialization to replace the captured intent", () => {
    const f = fixture();
    f.boundary.captureCharacterSelection({ selectedCharacterId: "choice-a" });
    f.boundary.captureCharacterSelection({ selectedCharacterId: "choice-b" });
    expect(f.boundary.selectedCharacterId).toBe("choice-b");
    expect(f.boundary.lastInitOptions?.selectedCharacterId).toBe("choice-b");
  });

  it("snapshot and list sends retain the chosen character after storage changes", async () => {
    const f = await wireFixture("choice-a");
    tabStorage?.setItem("selectedCharacterId", "choice-b");
    await f.snapshot();
    f.network.onCharacterList({
      characters: [
        { id: "choice-a", name: "A" },
        { id: "choice-b", name: "B" },
      ],
    });
    expect(await f.drain()).toEqual([
      ["onEnterWorld", { characterId: "choice-a" }],
      ["onCharacterSelected", { characterId: "choice-a" }],
    ]);
  });

  it("latest explicit request survives stale acknowledgments and reconnect capture", async () => {
    const f = await wireFixture("choice-a");
    await f.snapshot();
    const acknowledgments: Array<string | null> = [];
    f.world.on(EventType.CHARACTER_SELECTED, (data) =>
      acknowledgments.push(data.characterId),
    );
    f.network.requestCharacterSelect("choice-b");
    f.network.onCharacterSelected({ characterId: "choice-a" });
    f.network.onCharacterSelected({ characterId: null });
    tabStorage?.setItem("selectedCharacterId", "foreign-choice");
    f.boundary.captureCharacterSelection(f.boundary.lastInitOptions!);
    expect(f.boundary.selectedCharacterId).toBe("choice-b");
    expect(acknowledgments).toEqual(["choice-a", null]);
    f.network.onCharacterList({
      characters: [
        { id: "choice-a", name: "A" },
        { id: "choice-b", name: "B" },
      ],
    });
    expect(await f.drain()).toEqual([
      ["onEnterWorld", { characterId: "choice-a" }],
      ["onCharacterSelected", { characterId: "choice-b" }],
      ["onCharacterSelected", { characterId: "choice-b" }],
    ]);
  });

  it("explicit null produces no anonymous or other-character entry", async () => {
    expect(process.env.PLAYWRIGHT_TEST).not.toBe("true");
    const f = await wireFixture(null);
    tabStorage?.setItem("selectedCharacterId", "choice-a");
    await f.snapshot();
    f.network.onCharacterList({ characters: [{ id: "choice-a", name: "A" }] });
    expect(await f.drain()).toEqual([]);
  });

  it("an authoritative spectator snapshot still skips ordinary entry", async () => {
    const f = await wireFixture("choice-a");
    await f.snapshot(true);
    expect(await f.drain()).toEqual([]);
  });
});

describe("explicit same-transport entry retry over real loopback packets", () => {
  for (const selected of ["choice-a", null]) {
    it(`preserves embedded character precedence over ${selected ?? "no saved choice"}`, async () => {
      const f = await wireFixture(selected);
      f.boundary.embeddedCharacterId = "embedded-choice";
      await f.snapshot();
      expect(f.network.requestEnterWorld()).toBe(false);
      expect(f.network.retryEnterWorld()).toBe(false);
      expect(await f.drain()).toEqual([
        ["onEnterWorld", { characterId: "embedded-choice" }],
      ]);
      expect(f.network.entryRetryState).toBeNull();
    });
  }

  it("preserves fresh-transport reconnect entry after the admitted snapshot completes", async () => {
    const f = await wireFixture("choice-a");
    await loadPhysX();
    await f.world.physics.init();
    f.network.id = "old-transport";
    const player = f.world.entities.add({
      id: "retained-player",
      name: "Retained previous transport player",
      type: "player",
      owner: "old-transport",
      position: [0, 30, 0],
      quaternion: [0, 0, 0, 1],
    });
    expect(player).toBeDefined();
    expect(f.world.entities.player?.id).toBe("retained-player");
    const kicks: EventMap[EventType.UI_KICK][] = [];
    f.world.on(EventType.UI_KICK, (event) => kicks.push(event));
    f.boundary.isReconnecting = true;
    await f.snapshot();
    expect(f.boundary.isReconnecting).toBe(false);
    expect(await f.drain()).toEqual([
      ["onEnterWorld", { characterId: "choice-a" }],
    ]);
    expect(f.network.entryRetryState).toBeNull();
    expect(f.network.retryEnterWorld()).toBe(false);
    await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
    expect(kicks).toEqual([
      { playerId: f.network.id, reason: "duplicate_user" },
    ]);
  });

  it("the public initial action shares explicit-ID single-flight admission with snapshots", async () => {
    const f = await wireFixture(null);
    expect(f.network.requestEnterWorld()).toBe(false);
    await f.snapshot();
    f.network.requestCharacterSelect("choice-a");
    expect(f.network.requestEnterWorld()).toBe(true);
    expect(f.network.requestEnterWorld()).toBe(false);
    await f.snapshot();
    expect(await f.drain()).toEqual([
      ["onCharacterSelected", { characterId: "choice-a" }],
      ["onEnterWorld", { characterId: "choice-a" }],
    ]);
  });

  it("offers only a genuine rejected intent and sends one explicit retry per response", async () => {
    const f = await wireFixture("choice-a");
    const states: Array<EntryRetryState | null> = [];
    const kicks: EventMap[EventType.UI_KICK][] = [];
    f.world.on(EventType.ENTRY_RETRY_CHANGED, ({ state }) =>
      states.push(state),
    );
    f.world.on(EventType.UI_KICK, (event) => kicks.push(event));
    await f.snapshot();
    await f.deliver("enterWorldRejected", {
      reason: "already_logged_in",
      message: "Owner is still active",
    });
    expect(f.network.entryRetryState).toMatchObject({
      characterId: "choice-a",
      status: "available",
    });
    expect(Object.isFrozen(f.network.entryRetryState)).toBe(true);
    tabStorage?.setItem("selectedCharacterId", "foreign-choice");
    expect(f.network.retryEnterWorld()).toBe(true);
    expect(f.network.retryEnterWorld()).toBe(false);
    expect(f.network.entryRetryState?.status).toBe("pending");
    expect(await f.drain()).toEqual([
      ["onEnterWorld", { characterId: "choice-a" }],
      ["onEnterWorld", { characterId: "choice-a" }],
    ]);
    await f.deliver("enterWorldRejected", {
      reason: "already_logged_in",
      message: "Owner remains active",
    });
    expect(f.network.entryRetryState?.status).toBe("available");
    expect(f.boundary.entryRetryTimer).toBeNull();
    expect(kicks).toEqual([]);
    expect(states.map((state) => state?.status)).toEqual([
      "available",
      "pending",
      "available",
    ]);
  });

  for (const method of ["enterWorldApproved", "reconnected"]) {
    it(`${method} clears matching recovery, not another character's response`, async () => {
      const f = await wireFixture("choice-a");
      const kicks: EventMap[EventType.UI_KICK][] = [];
      f.world.on(EventType.UI_KICK, (event) => kicks.push(event));
      await f.snapshot();
      await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
      expect(f.network.retryEnterWorld()).toBe(true);
      await f.deliver(method, { characterId: "choice-b" });
      expect(f.network.entryRetryState?.status).toBe("pending");
      await f.deliver(method, { characterId: "choice-a" });
      expect(f.network.entryRetryState).toBeNull();
      expect(f.boundary.entryRetryTimer).toBeNull();
      expect(f.network.retryEnterWorld()).toBe(false);
      await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
      expect(kicks).toEqual([]);
      await f.snapshot();
      expect(
        (await f.drain()).filter(([name]) => name === "onEnterWorld"),
      ).toHaveLength(2);
    });
  }

  for (const reason of [
    "state_unavailable",
    "auth_required",
    "credential_character_mismatch",
    "future_rejection",
  ]) {
    it(`${reason} is terminal rather than a duplicate-session retry`, async () => {
      const f = await wireFixture("choice-a");
      const kicks: EventMap[EventType.UI_KICK][] = [];
      f.world.on(EventType.UI_KICK, (event) => kicks.push(event));
      await f.snapshot();
      await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
      expect(f.network.retryEnterWorld()).toBe(true);
      await f.deliver("enterWorldRejected", { reason });
      expect(f.network.entryRetryState).toBeNull();
      expect(f.boundary.entryRetryTimer).toBeNull();
      expect(f.network.retryEnterWorld()).toBe(false);
      expect(kicks).toEqual([{ playerId: f.network.id, reason }]);
    });
  }

  for (const change of [
    "selection",
    "null",
    "kick",
    "disconnect",
    "destroy",
  ] as const) {
    it(`${change} cancels recovery and prevents a late rejection from offering retry`, async () => {
      const f = await wireFixture("choice-a");
      const kicks: EventMap[EventType.UI_KICK][] = [];
      f.world.on(EventType.UI_KICK, (event) => kicks.push(event));
      await f.snapshot();
      await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
      expect(f.network.retryEnterWorld()).toBe(true);
      if (change === "selection") f.network.requestCharacterSelect("choice-b");
      if (change === "null")
        f.boundary.captureCharacterSelection({ selectedCharacterId: null });
      if (change === "kick") await f.deliver("kick", "player_limit");
      if (change === "disconnect") await f.network.disconnect();
      if (change === "destroy") f.network.destroy();
      expect(f.network.entryRetryState).toBeNull();
      expect(f.boundary.entryRetryTimer).toBeNull();
      expect(f.network.retryEnterWorld()).toBe(false);
      if (change === "selection" || change === "null" || change === "kick") {
        await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
        expect(f.network.entryRetryState).toBeNull();
        expect(f.network.retryEnterWorld()).toBe(false);
        expect(kicks).toEqual(
          change === "kick"
            ? [{ playerId: f.network.id, reason: "player_limit" }]
            : [],
        );
        if (change === "selection") {
          f.network.requestCharacterSelect("choice-a");
          await f.snapshot();
          await f.deliver("enterWorldRejected", {
            reason: "already_logged_in",
          });
          expect(f.network.entryRetryState).toBeNull();
          expect(kicks).toEqual([]);
        }
      }
    });
  }

  it("a pending event listener can cancel the selection before any retry is sent", async () => {
    const f = await wireFixture("choice-a");
    await f.snapshot();
    await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
    f.world.on(EventType.ENTRY_RETRY_CHANGED, ({ state }) => {
      if (state?.status === "pending")
        f.network.requestCharacterSelect("choice-b");
    });
    expect(f.network.retryEnterWorld()).toBe(false);
    expect(f.boundary.entryRetryTimer).toBeNull();
    expect(await f.drain()).toEqual([
      ["onEnterWorld", { characterId: "choice-a" }],
      ["onCharacterSelected", { characterId: "choice-b" }],
    ]);
  });

  it("expires a pending request without resending or kicking, and accepts a late matching approval", async () => {
    const f = await wireFixture("choice-a");
    const kicks: EventMap[EventType.UI_KICK][] = [];
    f.world.on(EventType.UI_KICK, (event) => kicks.push(event));
    await f.snapshot();
    await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
    expect(f.network.retryEnterWorld()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 15_050));
    expect(f.network.entryRetryState?.status).toBe("expired");
    expect(f.boundary.entryRetryTimer).toBeNull();
    expect(f.network.retryEnterWorld()).toBe(false);
    expect(await f.drain()).toEqual([
      ["onEnterWorld", { characterId: "choice-a" }],
      ["onEnterWorld", { characterId: "choice-a" }],
    ]);
    await f.deliver("enterWorldRejected", { reason: "already_logged_in" });
    expect(f.network.entryRetryState?.status).toBe("expired");
    await f.deliver("enterWorldApproved", { characterId: "choice-a" });
    expect(f.network.entryRetryState).toBeNull();
    expect(kicks).toEqual([]);
  }, 20_000);
});
