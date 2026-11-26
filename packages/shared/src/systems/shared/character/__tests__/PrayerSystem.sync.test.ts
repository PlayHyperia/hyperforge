import EventEmitter from "eventemitter3";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../infrastructure/EventBus";
import { PrayerSystem } from "../PrayerSystem";
import { EventType, type PlayerJoinedPayload } from "../../../../types/events";
import type { World } from "../../../../core/World";

interface MockDatabaseRow {
  prayerLevel: number;
  prayerMaxPoints: number;
  prayerPoints: number;
  prayerPointUnits: number;
  activePrayers: string[];
}

interface PrayerTestWorld extends EventEmitter<string | symbol, unknown> {
  isServer: boolean;
  $eventBus: EventBus;
  entities: {
    get: ReturnType<typeof vi.fn>;
  };
  getPlayers: ReturnType<typeof vi.fn>;
  getSystem: ReturnType<typeof vi.fn>;
}

function createPrayerTestWorld(row: MockDatabaseRow): {
  world: PrayerTestWorld;
  emitted: Array<{ event: string; payload: unknown }>;
  database: {
    getPlayerAsync: ReturnType<typeof vi.fn>;
    savePlayer: ReturnType<typeof vi.fn>;
    commitPrayerStateOperationAsync: ReturnType<typeof vi.fn>;
  };
} {
  const emitter = new EventEmitter<string | symbol, unknown>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const database = {
    getPlayerAsync: vi.fn(async () => row),
    savePlayer: vi.fn(),
    commitPrayerStateOperationAsync: vi.fn(),
  };

  const originalEmit = emitter.emit.bind(emitter);
  const world = emitter as PrayerTestWorld;
  world.isServer = true;
  world.$eventBus = new EventBus();
  world.entities = {
    get: vi.fn(() => undefined),
  };
  world.getPlayers = vi.fn(() => []);
  world.getSystem = vi.fn((name: string) =>
    name === "database" ? database : undefined,
  );
  world.emit = ((event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return originalEmit(event, payload);
  }) as PrayerTestWorld["emit"];

  return { world, emitted, database };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PrayerSystem authoritative sync", () => {
  it("loads persisted prayer data on PLAYER_REGISTERED and re-syncs it on PLAYER_JOINED", async () => {
    const { world, emitted, database } = createPrayerTestWorld({
      prayerLevel: 7,
      prayerMaxPoints: 7,
      prayerPoints: 5,
      prayerPointUnits: 5_000_000,
      activePrayers: ["thick_skin"],
    });
    const system = new PrayerSystem(world as unknown as World);

    await system.init();

    world.emit(EventType.PLAYER_REGISTERED, {
      playerId: "player-1",
    });
    await flushAsyncWork();

    const prayerSyncEventsAfterRegister = emitted.filter(
      ({ event }) => event === EventType.PRAYER_STATE_SYNC,
    );
    expect(database.getPlayerAsync).toHaveBeenCalledWith("player-1");
    expect(prayerSyncEventsAfterRegister).toHaveLength(1);
    expect(prayerSyncEventsAfterRegister[0]?.payload).toEqual({
      playerId: "player-1",
      level: 7,
      xp: 0,
      points: 5,
      maxPoints: 7,
      active: ["thick_skin"],
    });

    world.emit(EventType.PLAYER_JOINED, {
      playerId: "player-1",
      player: {} as PlayerJoinedPayload["player"],
    });
    await flushAsyncWork();

    const prayerSyncEventsAfterJoin = emitted.filter(
      ({ event }) => event === EventType.PRAYER_STATE_SYNC,
    );
    expect(prayerSyncEventsAfterJoin).toHaveLength(2);
    expect(prayerSyncEventsAfterJoin[1]?.payload).toEqual({
      playerId: "player-1",
      level: 7,
      xp: 0,
      points: 5,
      maxPoints: 7,
      active: ["thick_skin"],
    });

    system.destroy();
  });
});
