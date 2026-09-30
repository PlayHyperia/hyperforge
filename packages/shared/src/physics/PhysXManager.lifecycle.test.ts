import { expect, it } from "vitest";
import { World } from "../core/World";
import { DataManager } from "../data/DataManager";
import type { Entity } from "../entities/Entity";
import { PlayerLocal } from "../entities/player/PlayerLocal";
import { TerrainSystem } from "../systems/shared/world/TerrainSystem";
import {
  getPhysX,
  physxManager,
  PhysXState,
  waitForPhysX,
} from "./PhysXManager";

it("cleans cancelled and expired real PhysX waiters without cancelling shared loading", async () => {
  // The actual Node loader imports and initializes the real WASM module.
  // No replacement physics, events, timers or module state are installed.
  expect(physxManager.getState()).toBe(PhysXState.NOT_LOADED);
  const cancelledOwner = new AbortController();
  const reason = new Error("Retired PhysX consumer");
  // The first caller owns the short deadline, including actual module loading.
  const expired = waitForPhysX("same-name", 1);
  const expiredResult = expired.catch((error: unknown) => error);
  const cancelled = waitForPhysX("same-name", 60000, cancelledOwner.signal);
  const cancelledResult = cancelled.catch((error: unknown) => error);
  const survivor = waitForPhysX("same-name", 60000);
  expect(physxManager.getState()).toBe(PhysXState.LOADING);
  cancelledOwner.abort(reason);
  try {
    expect(await cancelledResult).toBe(reason);
    const expiry = await expiredResult;
    if (physxManager.getState() === PhysXState.LOADING) {
      expect(physxManager.listenerCount("loaded")).toBe(1);
      expect(physxManager.listenerCount("failed")).toBe(1);
      expect(physxManager["waitingDependencies"].size).toBe(1);
    }
    const info = await survivor;
    // An unusually fast real loader may win the 1 ms deadline. Both terminal
    // outcomes are valid; report which actual branch ran, without fake clocks.
    if (expiry instanceof Error)
      expect(expiry).toEqual(new Error("PhysX load timeout for same-name"));
    else expect(expiry).toBe(info);
    console.info(
      "PHYSX_LIFECYCLE",
      JSON.stringify({ timeoutObserved: expiry instanceof Error }),
    );
    expect(info).toBe(physxManager.getPhysXInfo());
    expect(getPhysX()).not.toBeNull();
    expect(physxManager.getState()).toBe(PhysXState.LOADED);
    expect(physxManager.listenerCount("loaded")).toBe(0);
    expect(physxManager.listenerCount("failed")).toBe(0);
    expect(physxManager["waitingDependencies"].size).toBe(0);
    await expect(
      waitForPhysX("already-retired", 60000, cancelledOwner.signal),
    ).rejects.toBe(reason);
    await expect(waitForPhysX("legacy-two-arguments", 60000)).resolves.toBe(
      info,
    );
  } finally {
    // Always consume actual shared startup, including baseline assertion failure.
    await Promise.allSettled([cancelled, expired, survivor]);
  }
}, 60000);

it("player terrain wait cleans partial activation when actual physics scene is absent", async () => {
  // Real terrain uses its CPU/server role; the local player's real PhysX module
  // is loaded, but this world deliberately has no started physics scene.
  class CpuServerWorld extends World {
    override get isServer(): boolean {
      return true;
    }
  }
  await DataManager.getInstance().initialize();
  const world = new CpuServerWorld();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  let player: PlayerLocal | undefined;
  try {
    await terrain.init();
    await terrain.start();
    player = new PlayerLocal(
      world,
      { id: "readiness-physics", position: [385, 28, 374] },
      true,
    );
    world.entities.items.set(player.id, player);
    world.entities.player = player as Entity as NonNullable<
      typeof world.entities.player
    >;
    await expect(player.init()).rejects.toThrow(
      "Physics scene not initialized",
    );
    expect(player.destroyed).toBe(true);
    expect(world.hot.has(player)).toBe(false);
    expect(player.capsule).toBeNull();
    expect(player["positionValidationInterval"]).toBeUndefined();
    expect(player["cameraRetryTimeout"]).toBeUndefined();
  } finally {
    player?.destroy();
    world.destroy();
  }
}, 60000);
