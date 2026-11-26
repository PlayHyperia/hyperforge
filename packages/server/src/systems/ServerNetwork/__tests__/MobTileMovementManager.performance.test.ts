import { describe, expect, it, vi } from "vitest";

import { MobTileMovementManager } from "../mob-tile-movement";

describe("MobTileMovementManager walkability performance", () => {
  it("blocks ungenerated terrain without procedural work", () => {
    const isPositionWalkableFast = vi.fn(() => true);
    const isPositionWalkable = vi.fn(() => {
      throw new Error("allocation-heavy walkability path must not run");
    });
    const terrain = {
      hasBakedWalkabilityAt: vi.fn(() => false),
      isPositionWalkable,
      isPositionWalkableFast,
    };
    const world = {
      currentTick: 42,
      collision: {
        hasFlags: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
      },
      getSystem: vi.fn((name: string) => (name === "terrain" ? terrain : null)),
    };

    const manager = new MobTileMovementManager(
      world as never,
      vi.fn(),
    ) as unknown as {
      isTileWalkable(tile: { x: number; z: number }): boolean;
    };

    expect(manager.isTileWalkable({ x: 350, z: 405 })).toBe(false);
    expect(manager.isTileWalkable({ x: 350, z: 405 })).toBe(false);
    expect(terrain.hasBakedWalkabilityAt).toHaveBeenCalledTimes(1);
    expect(isPositionWalkableFast).not.toHaveBeenCalled();
    expect(isPositionWalkable).not.toHaveBeenCalled();

    world.currentTick = 43;
    expect(manager.isTileWalkable({ x: 350, z: 405 })).toBe(false);
    expect(terrain.hasBakedWalkabilityAt).toHaveBeenCalledTimes(2);
    expect(isPositionWalkableFast).not.toHaveBeenCalled();
  });

  it("trusts baked collision flags without procedural terrain work", () => {
    const isPositionWalkableFast = vi.fn(() => true);
    const hasBakedWalkabilityAt = vi.fn(() => true);
    const world = {
      currentTick: 7,
      collision: {
        hasFlags: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
      },
      getSystem: vi.fn((name: string) =>
        name === "terrain"
          ? { hasBakedWalkabilityAt, isPositionWalkableFast }
          : null,
      ),
    };

    const manager = new MobTileMovementManager(
      world as never,
      vi.fn(),
    ) as unknown as {
      isTileWalkable(tile: { x: number; z: number }): boolean;
    };

    expect(manager.isTileWalkable({ x: 350, z: 405 })).toBe(true);
    expect(hasBakedWalkabilityAt).toHaveBeenCalledTimes(1);
    expect(isPositionWalkableFast).not.toHaveBeenCalled();
  });
});
