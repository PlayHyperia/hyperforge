import { describe, expect, it } from "vitest";
import { InteractableEntity } from "../InteractableEntity";

describe("InteractableEntity interaction footprint", () => {
  it("derives the exact rectangular bounds from occupied collision tiles", () => {
    const entity = Object.create(
      InteractableEntity.prototype,
    ) as InteractableEntity & {
      getOccupiedTiles: () => Array<{ x: number; z: number }>;
    };
    entity.getOccupiedTiles = () => [
      { x: 19, z: 19 },
      { x: 19, z: 20 },
      { x: 20, z: 19 },
      { x: 20, z: 20 },
    ];

    expect(entity.getInteractionFootprint()).toEqual({ width: 2, depth: 2 });
  });

  it("fails closed to a single tile when an entity reports no occupied tiles", () => {
    const entity = Object.create(
      InteractableEntity.prototype,
    ) as InteractableEntity & {
      getOccupiedTiles: () => Array<{ x: number; z: number }>;
    };
    entity.getOccupiedTiles = () => [];

    expect(entity.getInteractionFootprint()).toEqual({ width: 1, depth: 1 });
  });
});
