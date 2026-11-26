import { describe, expect, it } from "vitest";
import { SeededRandom } from "../../../../utils/SeededRandom";
import { createGrassPlacementCellOperations } from "../../../../utils/workers/GrassPlacementCell";
import {
  GRASS_MEADOW_DETAIL_BUDGET,
  selectGrassMeadowDetail,
  type GrassMeadowDetailClump,
  type GrassMeadowDetailSlot,
} from "../GrassMeadowDetailBudget";

const camera = Object.freeze({ x: 0, z: 0 });

/** Actual placement-domain validation and stratified sampling, not replacement
 * worker/renderer methods. Admission/ground contact remains the caller's
 * responsibility: these CPU tests prove selection and budgeting only. */
function sampledClumps(spacing: number): readonly GrassMeadowDetailClump[] {
  const operations = createGrassPlacementCellOperations();
  const rng = new SeededRandom(73856093);
  const clumps: GrassMeadowDetailClump[] = [];
  for (const indexX of [-1, 0]) {
    for (const indexZ of [-1, 0]) {
      const domain = operations.resolveDomain({
        centerX: 0,
        centerZ: 0,
        size: 50,
        clumpSpacing: spacing,
        spacingMul: 1,
        placementCell: { schemaVersion: 1, size: 25, indexX, indexZ },
        placementDistribution: "fine-cell-stratified-v1",
      });
      for (let index = 0; index < domain.maxCount; index++) {
        const position = { x: 0, z: 0, leafX: 0, leafZ: 0 };
        operations.samplePosition(
          domain,
          index,
          rng.random(),
          rng.random(),
          position,
        );
        clumps.push(
          Object.freeze({
            id: `generation7/cell${indexX},${indexZ}/source${index}`,
            x: Math.fround(position.leafX),
            z: Math.fround(position.leafZ),
          }),
        );
      }
    }
  }
  return Object.freeze(clumps);
}

function retiringSlots(count: number): GrassMeadowDetailSlot[] {
  return Array.from({ length: count }, (_, i) => ({
    slotId: `old-slot-${i}`,
    clumpId: `old-generation/clump-${i}`,
    phase: "retiring",
  }));
}

describe("bounded meadow detail selection without population ownership", () => {
  it("pins and freezes the explicit distance and overlap budget", () => {
    expect(GRASS_MEADOW_DETAIL_BUDGET).toEqual({
      capacity: 640,
      fullDetailDistance: 3.5,
      coarseDistance: 5,
      prepareDistance: 6,
    });
    expect(Object.isFrozen(GRASS_MEADOW_DETAIL_BUDGET)).toBe(true);
    expect(
      selectGrassMeadowDetail({ camera, clumps: [], occupied: [] }),
    ).toEqual({
      targets: [],
      prepareIds: [],
      occupiedSlots: 0,
      remainingSlots: 640,
    });
  });

  it("returns exact endpoint weights and smooth interpolation, with an inclusive preparation ring", () => {
    const distances = [0, 3.5, 3.500001, 4.25, 4.999999, 5, 5.5, 6, 6.000001];
    const result = selectGrassMeadowDetail({
      camera,
      clumps: distances.map((x, i) => ({ id: `clump-${i}`, x, z: 0 })),
      occupied: [],
    });
    expect(result.prepareIds).toEqual(
      distances.slice(0, 8).map((_, i) => `clump-${i}`),
    );
    expect(result.targets.map((target) => target.targetWeight)).toEqual([
      1,
      1,
      expect.closeTo(1, 10),
      0.5,
      expect.closeTo(0, 10),
      0,
      0,
      0,
    ]);
    for (const target of result.targets) {
      expect(target.slotId).toBeNull();
      expect(target.targetWeight).toBeGreaterThanOrEqual(0);
      expect(target.targetWeight).toBeLessThanOrEqual(1);
    }
    const sampled = selectGrassMeadowDetail({
      camera,
      clumps: Array.from({ length: 151 }, (_, i) => ({
        id: `sample-${i}`,
        x: 3.5 + i / 100,
        z: 0,
      })),
      occupied: [],
    }).targets;
    for (let i = 1; i < sampled.length; i++)
      expect(sampled[i].targetWeight).toBeLessThanOrEqual(
        sampled[i - 1].targetWeight,
      );
  });

  it("uses distance, then explicit code-unit IDs for ties, independent of input order", () => {
    const clumps = [
      { id: "ä", x: 1, z: 0 },
      { id: "Z", x: -1, z: 0 },
      { id: "a", x: 0, z: 1 },
      { id: "A", x: 0, z: -1 },
      { id: "nearer", x: 0.5, z: 0 },
    ];
    const occupied = retiringSlots(637);
    const forward = selectGrassMeadowDetail({ camera, clumps, occupied });
    const reverse = selectGrassMeadowDetail({
      camera,
      clumps: [...clumps].reverse(),
      occupied: [...occupied].reverse(),
    });
    expect(forward).toEqual(reverse);
    expect(forward.prepareIds).toEqual(["nearer", "A", "Z"]);
    expect(forward.remainingSlots).toBe(0);
  });

  it("selects existing half-metre sampled clumps without mutation, reseeding or losing population", () => {
    const clumps = sampledClumps(0.5);
    expect(clumps).toHaveLength(10000);
    const before = JSON.stringify(clumps);
    const first = selectGrassMeadowDetail({ camera, clumps, occupied: [] });
    const second = selectGrassMeadowDetail({
      camera,
      clumps: [...clumps].reverse(),
      occupied: [],
    });
    expect(first).toEqual(second);
    expect(first.targets.length).toBeGreaterThan(400);
    expect(first.targets.length).toBeLessThan(640);
    const expected = clumps.filter(({ x, z }) => x * x + z * z <= 36);
    expect(new Set(first.prepareIds)).toEqual(
      new Set(expected.map(({ id }) => id)),
    );
    expect(JSON.stringify(clumps)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.targets)).toBe(true);
    expect(Object.isFrozen(first.prepareIds)).toBe(true);
    expect(first.targets.every(Object.isFrozen)).toBe(true);
  });

  it("caps an oversubscribed real stratified domain at the nearest 640 identities", () => {
    // The existing domain validator also admits this denser input. It is a
    // capacity test, not a proposed change to the field's 0.5m placement.
    const clumps = sampledClumps(0.4);
    const expected = [...clumps]
      .filter(({ x, z }) => Math.hypot(x, z) <= 6)
      .sort((a, b) => {
        const distance = a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z);
        return distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
    expect(expected.length).toBeGreaterThan(640);
    const result = selectGrassMeadowDetail({ camera, clumps, occupied: [] });
    expect(result.prepareIds).toEqual(
      expected.slice(0, 640).map(({ id }) => id),
    );
    expect(result.targets).toHaveLength(640);
    expect(result.remainingSlots).toBe(0);
    expect(result).toEqual(
      selectGrassMeadowDetail({
        camera,
        clumps: [...clumps].reverse(),
        occupied: [],
      }),
    );
  });

  it("counts retiring plus pending replacement slots separately without duplicate targets", () => {
    const occupied: GrassMeadowDetailSlot[] = [
      ...retiringSlots(638),
      { slotId: "old", clumpId: "replacement", phase: "retiring" },
      { slotId: "new", clumpId: "replacement", phase: "pending" },
    ];
    const clumps = [
      { id: "replacement", x: 1, z: 0 },
      { id: "closer-unallocated", x: 0, z: 0 },
      { id: "old-generation/clump-0", x: 0, z: 0 },
    ];
    const result = selectGrassMeadowDetail({ camera, clumps, occupied });
    expect(result).toEqual({
      targets: [
        {
          clumpId: "replacement",
          slotId: "new",
          distanceSquared: 1,
          targetWeight: 1,
        },
      ],
      prepareIds: [],
      occupiedSlots: 640,
      remainingSlots: 0,
    });
    expect(occupied).toHaveLength(640);
    expect(clumps).toHaveLength(3);
  });

  it("keeps explicit zero endpoints for outside-band and missing active/pending identities", () => {
    const result = selectGrassMeadowDetail({
      camera,
      clumps: [
        { id: "outside-prepare", x: 7, z: 0 },
        { id: "outside-detail", x: 5.5, z: 0 },
        { id: "retiring-current", x: 0, z: 0 },
        { id: "fresh", x: 0, z: 0 },
      ],
      occupied: [
        { slotId: "active", clumpId: "outside-prepare", phase: "active" },
        { slotId: "pending", clumpId: "outside-detail", phase: "pending" },
        { slotId: "stale", clumpId: "missing", phase: "active" },
        { slotId: "retire", clumpId: "retiring-current", phase: "retiring" },
      ],
    });
    expect(result.targets).toEqual([
      { clumpId: "fresh", slotId: null, distanceSquared: 0, targetWeight: 1 },
      {
        clumpId: "outside-detail",
        slotId: "pending",
        distanceSquared: 30.25,
        targetWeight: 0,
      },
      {
        clumpId: "outside-prepare",
        slotId: "active",
        distanceSquared: 49,
        targetWeight: 0,
      },
      {
        clumpId: "missing",
        slotId: "stale",
        distanceSquared: null,
        targetWeight: 0,
      },
    ]);
    expect(result.prepareIds).toEqual(["fresh"]);
    expect(result.occupiedSlots).toBe(4);
    expect(result.remainingSlots).toBe(635);
  });

  it("does not reuse camera-cut capacity until the lifecycle owner releases it", () => {
    const clumps = [
      { id: "old-view", x: 0, z: 0 },
      { id: "new-view", x: 100, z: 100 },
    ];
    const occupied: GrassMeadowDetailSlot[] = [
      ...retiringSlots(639),
      { slotId: "visible", clumpId: "old-view", phase: "active" },
    ];
    expect(
      selectGrassMeadowDetail({ camera, clumps, occupied }).targets[0]
        .targetWeight,
    ).toBe(1);
    const cut = { x: 100, z: 100 };
    const waiting = selectGrassMeadowDetail({ camera: cut, clumps, occupied });
    expect(waiting.prepareIds).toEqual([]);
    expect(waiting.targets).toEqual([
      {
        clumpId: "old-view",
        slotId: "visible",
        distanceSquared: 20000,
        targetWeight: 0,
      },
    ]);
    const released = selectGrassMeadowDetail({
      camera: cut,
      clumps,
      occupied: occupied.slice(0, -1),
    });
    expect(released.prepareIds).toEqual(["new-view"]);
    expect(released.occupiedSlots + released.prepareIds.length).toBe(640);
  });

  it("rejects ambiguous ownership, overflow and malformed numeric input without silently dropping slots", () => {
    const clump = { id: "one", x: 0, z: 0 };
    const slot: GrassMeadowDetailSlot = {
      slotId: "slot",
      clumpId: "one",
      phase: "active",
    };
    expect(() =>
      selectGrassMeadowDetail({
        camera,
        clumps: [],
        occupied: retiringSlots(641),
      }),
    ).toThrow();
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() =>
        selectGrassMeadowDetail({
          camera: { x: bad, z: 0 },
          clumps: [],
          occupied: [],
        }),
      ).toThrow();
      expect(() =>
        selectGrassMeadowDetail({
          camera: { x: 0, z: bad },
          clumps: [],
          occupied: [],
        }),
      ).toThrow();
      expect(() =>
        selectGrassMeadowDetail({
          camera,
          clumps: [{ ...clump, x: bad }],
          occupied: [],
        }),
      ).toThrow();
      expect(() =>
        selectGrassMeadowDetail({
          camera,
          clumps: [{ ...clump, z: bad }],
          occupied: [],
        }),
      ).toThrow();
    }
    for (const clumps of [
      [clump, { ...clump }],
      [{ ...clump, id: "" }],
      [{ ...clump, x: Number.MAX_VALUE }],
    ])
      expect(() =>
        selectGrassMeadowDetail({ camera, clumps, occupied: [] }),
      ).toThrow();
    const invalidSlots: GrassMeadowDetailSlot[][] = [
      [slot, { ...slot, clumpId: "other" }],
      [slot, { ...slot, slotId: "second", phase: "pending" }],
      [{ ...slot, slotId: "" }],
      [{ ...slot, clumpId: "" }],
      [{ ...slot, phase: "unknown" as GrassMeadowDetailSlot["phase"] }],
    ];
    for (const occupied of invalidSlots)
      expect(() =>
        selectGrassMeadowDetail({ camera, clumps: [clump], occupied }),
      ).toThrow();
  });
});
