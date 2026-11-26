import { CollisionFlag } from "@hyperforge/shared";
import { describe, expect, it } from "vitest";

import { selectReadablePreparationStagingPair } from "../preparationReadyStaging.js";

const BOUNDS = {
  centerX: -14,
  centerZ: -3,
  minX: -14,
  maxX: -14,
  minZ: -3,
  maxZ: -3,
} as const;

function collisionReader(flags: ReadonlyMap<string, number>) {
  return (x: number, z: number): number => flags.get(`${x},${z}`) ?? 0;
}

describe("selectReadablePreparationStagingPair", () => {
  it("derives identical slots when isolated hosts observe different transient occupants", () => {
    const baseline = selectReadablePreparationStagingPair(
      BOUNDS,
      collisionReader(new Map()),
    );
    expect(baseline).not.toBeNull();

    const firstHostFlags = new Map<string, number>([
      [
        `${baseline!.tiles[0].x},${baseline!.tiles[0].z}`,
        CollisionFlag.OCCUPIED_NPC,
      ],
      ["-13,-5", CollisionFlag.OCCUPIED_PLAYER],
    ]);
    const secondHostFlags = new Map<string, number>([
      [
        `${baseline!.tiles[1].x},${baseline!.tiles[1].z}`,
        CollisionFlag.OCCUPIED_PLAYER,
      ],
      ["-12,-4", CollisionFlag.OCCUPIED_NPC],
    ]);

    const firstHost = selectReadablePreparationStagingPair(
      BOUNDS,
      collisionReader(firstHostFlags),
    );
    const secondHost = selectReadablePreparationStagingPair(
      BOUNDS,
      collisionReader(secondHostFlags),
    );

    expect(firstHost).toEqual(baseline);
    expect(secondHost).toEqual(baseline);
    expect(firstHost!.separation).toBeGreaterThanOrEqual(2.75);
    expect(firstHost!.separation).toBeLessThanOrEqual(3.75);
  });

  it("continues to exclude authoritative static movement blockers", () => {
    const baseline = selectReadablePreparationStagingPair(
      BOUNDS,
      collisionReader(new Map()),
    );
    expect(baseline).not.toBeNull();

    const blocked = new Map<string, number>([
      [
        `${baseline!.tiles[0].x},${baseline!.tiles[0].z}`,
        CollisionFlag.BLOCKED | CollisionFlag.OCCUPIED_NPC,
      ],
    ]);
    const selected = selectReadablePreparationStagingPair(
      BOUNDS,
      collisionReader(blocked),
    );

    expect(selected).not.toBeNull();
    expect(selected).not.toEqual(baseline);
    expect(selected!.tiles).not.toContainEqual(baseline!.tiles[0]);
    expect(selected!.separation).toBeGreaterThanOrEqual(2.75);
    expect(selected!.separation).toBeLessThanOrEqual(3.75);
  });
});
