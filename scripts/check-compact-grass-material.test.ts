import { describe, expect, test } from "bun:test";
import {
  encodeMaterialWorkerInput,
  decodeMaterialWorkerInput,
  compareMaterialWorkerSnapshots,
  type MaterialWorkerSnapshot,
} from "./check-compact-grass-material";

describe("material worker evidence transport and comparison (not native GPU)", () => {
  test("preserves native Sets, Maps, undefined, -0 and exact typed populated slices", () => {
    const storage = new Float32Array([99, 0.1, -0, 0.7, 88]);
    const original = {
      keys: new Set(["3,4", "5,4"]),
      map: new Map([["x", new Uint16Array([1, 65535])]]),
      unset: undefined,
      zero: -0,
      view: storage.subarray(1, 4),
      bytes: new Uint8Array([4, 3, 2]).buffer,
    };
    const wire = JSON.parse(
      JSON.stringify(encodeMaterialWorkerInput(original)),
    );
    const decoded = decodeMaterialWorkerInput(wire) as typeof original;
    expect(decoded).toEqual(original);
    expect(decoded.keys instanceof Set).toBe(true);
    expect(decoded.view instanceof Float32Array).toBe(true);
    expect(decoded.view.byteLength).toBe(12);
    expect(new Uint8Array(decoded.view.buffer)).toEqual(
      new Uint8Array(storage.buffer, 4, 12),
    );
    expect(Object.is(decoded.zero, -0)).toBe(true);
    expect(Object.hasOwn(decoded, "unset")).toBe(true);
  });
  test("rejects lossy/unbounded/non-wire inputs instead of hiding them", () => {
    for (const bad of [
      NaN,
      Infinity,
      () => 0,
      new Date(),
      new DataView(new ArrayBuffer(4)),
      new Array(3),
    ])
      expect(() => encodeMaterialWorkerInput(bad)).toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => encodeMaterialWorkerInput(cycle)).toThrow();
  });
  // Scalar receipt-boundary fixture only; it is never used as worker/terrain evidence.
  function receipt(): MaterialWorkerSnapshot {
    const array = {
      type: "Float32Array" as const,
      length: 3,
      bytes: 12,
      sha256: "before",
    };
    return {
      schemaVersion: 1,
      scope: "unit scalar receipt",
      createdAt: "test",
      runtime: {
        node: "22",
        bun: "1.3.14",
        three: "0.186",
        architecture: "arm64",
        byteOrder: "little",
      },
      sourcePins: [],
      workerCodeSha256: "code",
      workerCodeBytes: 1,
      scene: {
        worldContentIdentity: "identity",
        profile: "profile",
        grassProfile: "grass",
        roads: 11,
        roadSegments: 222,
        focus: [385, 374],
      },
      totalClumps: 6,
      leaves: Array.from({ length: 6 }, (_, i) => ({
        center: [i, 0],
        inputSha256: `input${i}`,
        inputBytes: 10,
        chunkKey: `key${i}`,
        count: 1,
        grassEligibility: "compact-pbr-v1",
        terrainProfileIdentity: "identity",
        arrays: {
          offsets: { ...array },
          rotScaleHash: { ...array },
          grassTints: { ...array, length: 4, bytes: 16 },
          groundNormals: { ...array },
          groundColors: { ...array },
        },
      })),
    };
  }
  test("requires changed colors in all leaves, while all non-color/input/state evidence agrees", () => {
    const before = receipt(),
      after = structuredClone(before);
    expect(compareMaterialWorkerSnapshots(before, after).passed).toBe(false);
    for (const leaf of after.leaves) leaf.arrays.groundColors.sha256 = "after";
    expect(compareMaterialWorkerSnapshots(before, after).passed).toBe(true);
    for (const field of [
      "offsets",
      "rotScaleHash",
      "grassTints",
      "groundNormals",
    ] as const) {
      const changed = structuredClone(after);
      changed.leaves[0].arrays[field].sha256 = "wrong";
      expect(compareMaterialWorkerSnapshots(before, changed).passed).toBe(
        false,
      );
      expect(
        compareMaterialWorkerSnapshots(before, changed)
          .unchangedNonColorArrayViews,
      ).toBe(23);
    }
    for (const mutate of [
      (r: MaterialWorkerSnapshot) => (r.leaves[0].inputSha256 = "wrong"),
      (r: MaterialWorkerSnapshot) => r.leaves[0].count++,
      (r: MaterialWorkerSnapshot) =>
        (r.leaves[0].terrainProfileIdentity = "wrong"),
      (r: MaterialWorkerSnapshot) => r.leaves[0].arrays.groundColors.length++,
      (r: MaterialWorkerSnapshot) => r.leaves.pop(),
      (r: MaterialWorkerSnapshot) => r.scene.roads++,
    ]) {
      const changed = structuredClone(after);
      mutate(changed);
      expect(compareMaterialWorkerSnapshots(before, changed).passed).toBe(
        false,
      );
    }
  });
});
