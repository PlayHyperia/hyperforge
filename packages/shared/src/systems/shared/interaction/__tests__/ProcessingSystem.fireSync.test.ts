import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelCache } from "../../../../utils/rendering/ModelCache";
import type { World } from "../../../../types";
import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { ProcessingSystem } from "../ProcessingSystem";

describe("ProcessingSystem active-fire client synchronization", () => {
  let system: ProcessingSystem;
  let eventBus: EventBus;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.spyOn(modelCache, "loadModel").mockImplementation(
      () => new Promise(() => undefined),
    );
    eventBus = new EventBus();
    system = new ProcessingSystem({
      isServer: false,
      isClient: true,
      $eventBus: eventBus,
      entities: new Map(),
      stage: { scene: { add: vi.fn(), remove: vi.fn() } },
      collision: { hasFlags: vi.fn(), isWalkable: vi.fn() },
      getSystem: vi.fn(),
      getPlayer: vi.fn(),
    } as unknown as World);
    await system.init();
  });

  afterEach(() => {
    system.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates one visual registry entry for duplicate late-join payloads", () => {
    const payload = {
      fireId: "fire_sync-1",
      playerId: "agent-1",
      position: { x: 4.5, y: 0, z: 7.5 },
      createdAt: 990_000,
      expiresAt: 1_050_000,
      serverObservedAt: 1_000_000,
    };
    eventBus.emitEvent(EventType.FIRE_CREATED, payload, "test");
    eventBus.emitEvent(
      EventType.FIRE_CREATED,
      { ...payload, expiresAt: 1_060_000 },
      "test",
    );

    expect(system.getActiveFireIds()).toEqual(["fire_sync-1"]);
    expect(system.getActiveFirePayloads()).toEqual([
      {
        fireId: payload.fireId,
        playerId: payload.playerId,
        position: payload.position,
        createdAt: payload.createdAt,
        expiresAt: 1_060_000,
      },
    ]);
  });

  it("uses server time to ignore expired snapshots and removes fires idempotently", () => {
    eventBus.emitEvent(
      EventType.FIRE_CREATED,
      {
        fireId: "fire_expired",
        playerId: "agent-1",
        position: { x: 0.5, y: 0, z: 0.5 },
        createdAt: 900_000,
        expiresAt: 999_999,
        serverObservedAt: 1_000_000,
      },
      "test",
    );
    expect(system.getActiveFireIds()).toEqual([]);

    eventBus.emitEvent(
      EventType.FIRE_CREATED,
      {
        fireId: "fire_sync-2",
        playerId: "agent-1",
        position: { x: 0.5, y: 0, z: 0.5 },
        createdAt: 990_000,
        expiresAt: 1_050_000,
        serverObservedAt: 1_000_000,
      },
      "test",
    );
    eventBus.emitEvent(
      EventType.FIRE_EXTINGUISHED,
      { fireId: "fire_sync-2" },
      "test",
    );
    eventBus.emitEvent(
      EventType.FIRE_EXTINGUISHED,
      { fireId: "fire_sync-2" },
      "test",
    );
    expect(system.getActiveFireIds()).toEqual([]);
  });
});
