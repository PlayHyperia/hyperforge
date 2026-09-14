import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { SeededRandom } from "../SeededRandom";
import {
  createGrassPlacementCellOperations,
  getGrassPlacementCellBounds,
  type GrassPlacementCell,
  type GrassPlacementDomain,
  type GrassPlacementDomainInput,
} from "./GrassPlacementCell";

const operations = createGrassPlacementCellOperations();
const cell: GrassPlacementCell = {
  schemaVersion: 1,
  size: 25,
  indexX: 12,
  indexZ: 12,
};
const input: GrassPlacementDomainInput = {
  centerX: 350,
  centerZ: 350,
  size: 100,
  clumpSpacing: 0.7,
  spacingMul: 1,
  placementCell: cell,
};

describe("bounded grass-owned sampling cells", () => {
  it("detaches canonical cells and covers each real leaf exactly once", () => {
    const source = { ...cell };
    const admitted = operations.validateCell(source);
    expect(admitted).toEqual(source);
    expect(admitted).not.toBe(source);
    expect(Object.isFrozen(admitted)).toBe(true);
    source.indexX++;
    expect(admitted.indexX).toBe(12);
    let area = 0;
    const centers = new Set<string>();
    for (let x = 12; x < 16; x++)
      for (let z = 12; z < 16; z++) {
        const descriptor = { ...cell, indexX: x, indexZ: z };
        const bounds = getGrassPlacementCellBounds(descriptor);
        const domain = operations.resolveDomain({
          ...input,
          placementCell: descriptor,
        });
        expect(bounds).toEqual({
          minX: x * 25,
          maxX: (x + 1) * 25,
          minZ: z * 25,
          maxZ: (z + 1) * 25,
        });
        expect(Object.isFrozen(bounds)).toBe(true);
        expect(Object.isFrozen(domain)).toBe(true);
        expect(domain).toMatchObject({
          centerX: x * 25 + 12.5,
          centerZ: z * 25 + 12.5,
          size: 25,
          maxCount: 1276,
        });
        area += (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);
        centers.add(`${domain.centerX},${domain.centerZ}`);
      }
    expect(area).toBe(10000);
    expect(centers.size).toBe(16);
  });

  it("admits negative cells and canonical zero but rejects malformed or expansive descriptors", () => {
    expect(
      getGrassPlacementCellBounds({ ...cell, indexX: -1, indexZ: -1 }),
    ).toEqual({ minX: -25, maxX: 0, minZ: -25, maxZ: 0 });
    expect(
      Object.is(operations.validateCell({ ...cell, indexX: -0 }).indexX, -0),
    ).toBe(false);
    const getter = Object.defineProperty({ ...cell }, "indexX", {
      get() {
        throw new Error("must not execute accessor");
      },
    });
    for (const bad of [
      null,
      [],
      {},
      { ...cell, schemaVersion: 2 },
      { ...cell, size: 50 },
      { ...cell, indexX: NaN },
      { ...cell, indexZ: Infinity },
      { ...cell, indexX: 0.5 },
      { ...cell, indexX: Number.MAX_SAFE_INTEGER + 1 },
      { ...cell, indexX: -4097 },
      { ...cell, indexX: 4096 },
      { ...cell, extra: false },
      { ...cell, [Symbol("extra")]: true },
      getter,
    ])
      expect(() => operations.validateCell(bad)).toThrow(
        "Invalid grass placement cell",
      );
  });

  it("rejects noncontained cells and oversized quotas without changing the legacy domain", () => {
    for (const change of [
      { centerX: NaN },
      { centerZ: Infinity },
      { size: 0 },
      { size: 99 },
      { centerX: 1e8 },
      { size: 1e9 },
      { clumpSpacing: 0 },
      { clumpSpacing: -1 },
      { clumpSpacing: NaN },
      { spacingMul: Infinity },
      { spacingMul: 0 },
      { clumpSpacing: 0.39 },
      { placementCell: { ...cell, indexX: 16 } },
    ])
      expect(() => operations.resolveDomain({ ...input, ...change })).toThrow(
        "Invalid grass placement cell",
      );
    expect(
      operations.resolveDomain({ ...input, clumpSpacing: 25 / 64 }).maxCount,
    ).toBe(4096);
    const legacy = operations.resolveDomain({
      ...input,
      placementCell: undefined,
    });
    expect(legacy).toEqual({
      centerX: 350,
      centerZ: 350,
      size: 100,
      maxCount: 20409,
    });
    expect(Object.hasOwn(legacy, "placementCell")).toBe(false);
  });

  it("runs the exact self-contained factory in fresh and minified keepNames contexts", () => {
    const source = `(${createGrassPlacementCellOperations.toString()})()`;
    const bundled = transformSync(
      `globalThis.factory = ${createGrassPlacementCellOperations.toString()};`,
      { minify: true, keepNames: true, target: "es2022" },
    ).code;
    const emittedFactory = runInNewContext(
      `${bundled}; globalThis.factory`,
    ) as typeof createGrassPlacementCellOperations;
    // Serialize only the actual emitted factory, not the bundler's outer scope.
    for (const code of [source, `(${emittedFactory.toString()})()`]) {
      const actual = runInNewContext(code) as ReturnType<
        typeof createGrassPlacementCellOperations
      >;
      for (const x of [-1, 0, 12, 15]) {
        const query = {
          ...input,
          centerX: x < 1 ? 0 : 350,
          centerZ: x < 1 ? 0 : 350,
          placementCell: { ...cell, indexX: x, indexZ: x },
        };
        expect(actual.resolveDomain(query)).toEqual(
          operations.resolveDomain(query),
        );
      }
      expect(() =>
        actual.resolveDomain({
          ...input,
          placementCell: { ...cell, indexX: 16 },
        }),
      ).toThrow();
      expect(() => actual.validateCell({ ...cell, extra: 1 })).toThrow();
    }
  });
});

describe("exact-quota fine cell jittered strata", () => {
  const distribution = "fine-cell-stratified-v1" as const;
  const largestUnit = 1 - Number.EPSILON / 2;
  const largestWorkerUnit = 1 - 2 ** -32;
  const edgeQuotas = [
    1, 2, 3, 5, 7, 10, 15, 16, 17, 31, 63, 64, 65, 127, 255, 256, 257, 1276,
    4095, 4096,
  ];
  const queryFor = (
    quota: number,
    descriptor: GrassPlacementCell = cell,
  ): GrassPlacementDomainInput => ({
    ...input,
    centerX: (descriptor.indexX + 0.5) * 25,
    centerZ: (descriptor.indexZ + 0.5) * 25,
    size: 25,
    // Keep the independently requested ceil quota away from floating-point
    // integer ties instead of assuming 25 / sqrt(N) rounds in our favor.
    clumpSpacing: 25 / Math.sqrt(quota - 0.25),
    placementCell: descriptor,
    placementDistribution: distribution,
  });
  const sample = (
    domain: GrassPlacementDomain,
    index: number,
    u: number,
    v: number,
  ) => {
    const out = { x: NaN, z: NaN };
    operations.samplePosition(domain, index, u, v, out);
    return out;
  };
  // Independent forward partition traversal, not the sampler's inverse
  // candidate-index-to-row formula. Each row owns an integer candidate range.
  const rowsFor = (quota: number) => {
    const count = Math.round(Math.sqrt(quota));
    const rows = [];
    let start = 0;
    for (let row = 0; row < count; row++) {
      const end = Math.floor(((row + 1) * quota) / count);
      rows.push({
        start,
        end,
        columns: end - start,
        minZ: (start / quota - 0.5) * 25,
        maxZ: (end / quota - 0.5) * 25,
      });
      start = end;
    }
    return rows;
  };

  it("admits only the explicit policy on contained cells and leaves ordinary IID domains unchanged", () => {
    expect(operations.validateDistribution(undefined)).toBeUndefined();
    expect(operations.validateDistribution(distribution)).toBe(distribution);
    for (const invalid of [
      null,
      false,
      1,
      "",
      "fine-cell-stratified-v2",
      {},
      [],
    ]) {
      expect(() => operations.validateDistribution(invalid)).toThrow();
      expect(() =>
        operations.resolveDomain({
          ...queryFor(64),
          placementDistribution: invalid,
        } as GrassPlacementDomainInput),
      ).toThrow();
    }
    expect(() =>
      operations.resolveDomain({
        ...queryFor(64),
        placementCell: undefined,
      }),
    ).toThrow();
    expect(() =>
      operations.resolveDomain({
        ...input,
        placementDistribution: distribution,
        placementCell: { ...cell, indexX: 16 },
      }),
    ).toThrow();
    for (const placementCell of [undefined, cell]) {
      expect(() =>
        operations.resolveDomain({
          ...input,
          placementCell,
          placementDistribution: undefined,
        }),
      ).toThrow();
      const legacy = operations.resolveDomain({ ...input, placementCell });
      for (const key of ["placementDistribution", "strataRows", "leafFrame"])
        expect(Object.hasOwn(legacy, key)).toBe(false);
      expect(legacy.maxCount).toBe(placementCell ? 1276 : 20409);
      for (const index of [0, legacy.maxCount - 1])
        for (const [u, v] of [
          [0, 0],
          [largestUnit, largestUnit],
          [0.23, 0.79],
        ])
          expect(sample(legacy, index, u, v)).toEqual({
            x: (u - 0.5) * legacy.size,
            z: (v - 0.5) * legacy.size,
          });
    }
  });

  it("partitions every quota 1..4096 into exactly N equal-area strata without truncating a final row", () => {
    for (let quota = 1; quota <= 4096; quota++) {
      const domain = operations.resolveDomain(queryFor(quota));
      const rows = rowsFor(quota);
      expect(domain.maxCount).toBe(quota);
      expect(domain.placementDistribution).toBe(distribution);
      expect(domain.strataRows).toBe(rows.length);
      expect(Object.isFrozen(domain)).toBe(true);
      const failures: string[] = [];
      let count = 0;
      let area = 0;
      let previousMaxZ = -12.5;
      for (const row of rows) {
        const stratumArea = (25 / row.columns) * (row.maxZ - row.minZ);
        if (
          row.start !== count ||
          row.columns < 1 ||
          row.minZ !== previousMaxZ ||
          Math.abs(stratumArea - 625 / quota) > 1e-11
        )
          failures.push(`partition at candidate ${row.start}`);
        for (const index of new Set([row.start, row.end - 1])) {
          const point = sample(domain, index, 0.5, 0.5);
          const expectedX =
            ((index - row.start + 0.5) / row.columns - 0.5) * 25;
          const expectedZ = (row.minZ + row.maxZ) / 2;
          if (
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.z) ||
            Math.abs(point.x - expectedX) > 1e-12 ||
            Math.abs(point.z - expectedZ) > 1e-12
          )
            failures.push(`center of candidate ${index}`);
        }
        count += row.columns;
        area += row.columns * stratumArea;
        previousMaxZ = row.maxZ;
      }
      expect(failures, `quota ${quota}`).toEqual([]);
      expect(count).toBe(quota);
      expect(area).toBeCloseTo(625, 9);
      expect(previousMaxZ).toBe(12.5);
    }
  });

  it("keeps every selected candidate in its unique half-open stratum, including extreme valid jitters", () => {
    for (const quota of edgeQuotas) {
      const domain = operations.resolveDomain(queryFor(quota));
      for (const [u, v] of [
        [0, 0],
        [0, largestUnit],
        [largestUnit, 0],
        [largestUnit, largestUnit],
        [2 ** -32, largestWorkerUnit],
        [largestWorkerUnit, 2 ** -32],
        [0.23, 0.79],
      ]) {
        const seen = new Set<string>();
        const failures: number[] = [];
        const scratch = { x: NaN, z: NaN };
        for (const row of rowsFor(quota))
          for (let index = row.start; index < row.end; index++) {
            const column = index - row.start;
            const minX = (column / row.columns - 0.5) * 25;
            const maxX = ((column + 1) / row.columns - 0.5) * 25;
            operations.samplePosition(domain, index, u, v, scratch);
            // Linear interpolation over independently constructed rectangles
            // must retain every real 32-bit RNG draw; only larger hypothetical
            // unit inputs meet the documented upper-interior guard.
            const expectedX =
              minX + (maxX - minX) * Math.min(u, largestWorkerUnit);
            const expectedZ =
              row.minZ + (row.maxZ - row.minZ) * Math.min(v, largestWorkerUnit);
            if (
              !Number.isFinite(scratch.x) ||
              !Number.isFinite(scratch.z) ||
              Math.abs(scratch.x - expectedX) > 1e-12 ||
              Math.abs(scratch.z - expectedZ) > 1e-12 ||
              scratch.x < minX ||
              scratch.x >= maxX ||
              scratch.z < row.minZ ||
              scratch.z >= row.maxZ ||
              scratch.x < -12.5 ||
              scratch.x >= 12.5 ||
              scratch.z < -12.5 ||
              scratch.z >= 12.5
            )
              failures.push(index);
            seen.add(`${scratch.x},${scratch.z}`);
          }
        expect(failures, `quota ${quota}, jitter ${u}/${v}`).toEqual([]);
        expect(seen.size).toBe(quota);
      }
    }
  });

  it("rejects forged or foreign domains and invalid candidate inputs before mutating scratch output", () => {
    const domain = operations.resolveDomain(queryFor(64));
    const foreign = createGrassPlacementCellOperations().resolveDomain(
      queryFor(64),
    );
    for (const invalid of [
      Object.freeze({ ...domain }),
      Object.freeze({ ...domain, maxCount: 0 }),
      Object.freeze({ ...domain, strataRows: 0 }),
      Object.freeze({ ...domain, placementDistribution: "unsupported" }),
      foreign,
    ]) {
      const scratch = { x: 123, z: -456 };
      expect(() =>
        operations.samplePosition(
          invalid as GrassPlacementDomain,
          0,
          0.5,
          0.5,
          scratch,
        ),
      ).toThrow();
      expect(scratch).toEqual({ x: 123, z: -456 });
    }
    for (const index of [
      -1,
      0.5,
      64,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const scratch = { x: 123, z: -456 };
      expect(() =>
        operations.samplePosition(domain, index, 0.5, 0.5, scratch),
      ).toThrow();
      expect(scratch).toEqual({ x: 123, z: -456 });
    }
    for (const invalid of [-Number.MIN_VALUE, -1, 1, NaN, Infinity, -Infinity])
      for (const [u, v] of [
        [invalid, 0.5],
        [0.5, invalid],
      ]) {
        const scratch = { x: 123, z: -456 };
        expect(() =>
          operations.samplePosition(domain, 0, u, v, scratch),
        ).toThrow();
        expect(scratch).toEqual({ x: 123, z: -456 });
      }
  });

  it("is repeatable and half-open across neighboring, negative and bounded-world edge cells", () => {
    const occupied = new Set<string>();
    for (const [indexX, indexZ] of [
      [-4096, -4096],
      [-2, -1],
      [-1, -1],
      [-1, 0],
      [0, 0],
      [1, 0],
      [4095, 4095],
    ]) {
      const descriptor = { ...cell, indexX, indexZ };
      const domain = operations.resolveDomain(queryFor(127, descriptor));
      const bounds = operations.getBounds(descriptor);
      const rng = new SeededRandom(
        0x71eaf ^ (indexX * 374761393 + indexZ * 668265263),
      );
      const failures: number[] = [];
      for (let index = 0; index < domain.maxCount; index++) {
        const u = rng.random();
        const v = rng.random();
        const first = sample(domain, index, u, v);
        expect(sample(domain, index, u, v)).toEqual(first);
        const x = domain.centerX + first.x;
        const z = domain.centerZ + first.z;
        if (
          x < bounds.minX ||
          x >= bounds.maxX ||
          z < bounds.minZ ||
          z >= bounds.maxZ
        )
          failures.push(index);
        occupied.add(`${x},${z}`);
      }
      expect(failures, `cell ${indexX}/${indexZ}`).toEqual([]);
    }
    expect(occupied.size).toBe(7 * 127);
  });

  it("retains half-open ownership after actual Float32 leaf-offset storage and world reconstruction", () => {
    // These are real 100 m terrain-leaf frames, not cell-centered stand-ins.
    // They include local upper/lower zero, neighboring cells and world limits.
    // This tests actual CPU storage/reconstruction, not GPU shader execution.
    const frames = [
      { center: 0, cells: [-1, 0] },
      { center: 300, cells: [11, 12] },
      { center: 350, cells: [13, 14] },
      { center: -102350, cells: [-4096] },
      { center: 102350, cells: [4095] },
    ];
    const stored = new Float32Array(2);
    for (const { center, cells } of frames)
      for (const indexX of cells)
        for (const indexZ of cells)
          for (const quota of [1, 7, 1276, 4096]) {
            const descriptor = { ...cell, indexX, indexZ };
            const query = {
              ...queryFor(quota, descriptor),
              centerX: center,
              centerZ: center,
              size: 100,
            };
            const domain = operations.resolveDomain(query);
            const bounds = operations.getBounds(descriptor);
            expect(domain.leafFrame).toMatchObject({
              centerX: query.centerX,
              centerZ: query.centerZ,
              minX: bounds.minX - query.centerX,
              maxX: bounds.maxX - query.centerX,
              minZ: bounds.minZ - query.centerZ,
              maxZ: bounds.maxZ - query.centerZ,
              worldBounds: bounds,
            });
            expect(Object.isFrozen(domain.leafFrame)).toBe(true);
            expect(Object.isFrozen(domain.leafFrame?.worldBounds)).toBe(true);
            for (const [u, v] of [
              [0, 0],
              [largestWorkerUnit, largestWorkerUnit],
              [largestUnit, largestUnit],
              [0, largestUnit],
              [largestUnit, 0],
            ]) {
              const failures: number[] = [];
              const seen = new Set<string>();
              const scratch = { x: NaN, z: NaN, leafX: NaN, leafZ: NaN };
              for (let index = 0; index < quota; index++) {
                operations.samplePosition(domain, index, u, v, scratch);
                // Production consumes these fields directly. Reconstructing
                // leaf offsets from ideal x/z here would miss the storage bug.
                stored[0] = scratch.leafX;
                stored[1] = scratch.leafZ;
                const worldX = query.centerX + stored[0];
                const worldZ = query.centerZ + stored[1];
                const idealLeafX = domain.centerX - query.centerX + scratch.x;
                const idealLeafZ = domain.centerZ - query.centerZ + scratch.z;
                if (
                  !Number.isFinite(stored[0]) ||
                  !Number.isFinite(stored[1]) ||
                  stored[0] !== Math.fround(scratch.leafX) ||
                  stored[1] !== Math.fround(scratch.leafZ) ||
                  worldX < bounds.minX ||
                  worldX >= bounds.maxX ||
                  worldZ < bounds.minZ ||
                  worldZ >= bounds.maxZ ||
                  Math.abs(stored[0] - idealLeafX) > 1e-5 ||
                  Math.abs(stored[1] - idealLeafZ) > 1e-5
                )
                  failures.push(index);
                seen.add(`${stored[0]},${stored[1]}`);
              }
              expect(
                failures,
                `leaf ${center}, cell ${indexX}/${indexZ}, quota ${quota}, jitter ${u}/${v}`,
              ).toEqual([]);
              expect(seen.size).toBe(quota);
            }
          }
  });

  it("runs identical actual sampling from fresh and minified self-contained factory source", () => {
    const source = `(${createGrassPlacementCellOperations.toString()})()`;
    const bundled = transformSync(
      `globalThis.factory = ${createGrassPlacementCellOperations.toString()};`,
      { minify: true, keepNames: true, target: "es2022" },
    ).code;
    const emittedFactory = runInNewContext(
      `${bundled}; globalThis.factory`,
    ) as typeof createGrassPlacementCellOperations;
    for (const code of [source, `(${emittedFactory.toString()})()`]) {
      const actual = runInNewContext(code) as ReturnType<
        typeof createGrassPlacementCellOperations
      >;
      for (const quota of [1, 7, 64, 1276, 4096])
        for (const indexX of [-1, 0, 12]) {
          const query = {
            ...queryFor(quota, { ...cell, indexX }),
            centerX: indexX < 1 ? 0 : 350,
            centerZ: 350,
            size: 100,
          };
          const expectedDomain = operations.resolveDomain(query);
          const actualDomain = actual.resolveDomain(query);
          expect(actualDomain).toEqual(expectedDomain);
          const rng = new SeededRandom(quota ^ indexX);
          const failures: number[] = [];
          const scratch = { x: NaN, z: NaN, leafX: NaN, leafZ: NaN };
          const expected = { x: NaN, z: NaN, leafX: NaN, leafZ: NaN };
          for (let index = 0; index < quota; index++) {
            const u =
              index === 0
                ? 0
                : index === quota - 1
                  ? largestUnit
                  : rng.random();
            const v =
              index === 0
                ? largestUnit
                : index === quota - 1
                  ? 0
                  : rng.random();
            actual.samplePosition(actualDomain, index, u, v, scratch);
            operations.samplePosition(expectedDomain, index, u, v, expected);
            if (
              scratch.x !== expected.x ||
              scratch.z !== expected.z ||
              scratch.leafX !== expected.leafX ||
              scratch.leafZ !== expected.leafZ
            )
              failures.push(index);
          }
          expect(failures, `emitted quota ${quota}, cell ${indexX}`).toEqual(
            [],
          );
          expect(() =>
            actual.samplePosition(expectedDomain, 0, 0.5, 0.5, scratch),
          ).toThrow();
          expect(() =>
            actual.samplePosition(actualDomain, quota, 0.5, 0.5, scratch),
          ).toThrow();
        }
      expect(() =>
        actual.resolveDomain({ ...queryFor(64), placementCell: undefined }),
      ).toThrow();
      expect(() =>
        actual.validateDistribution("fine-cell-stratified-v2"),
      ).toThrow();
    }
  });

  it("improves raw same-count spatial coverage against IID across fixed seeds, before any ecology or rendering", () => {
    // This is a pure candidate-distribution comparison. It does not measure
    // accepted plants, terrain filters, rendered pixels, runtime or GPU work.
    // Both populations receive exactly the same two unit draws per candidate.
    const totals = {
      strataEmpty: 0,
      iidEmpty: 0,
      bins: 0,
      strataNearestSquared: 0,
      iidNearestSquared: 0,
      strataUncovered: 0,
      iidUncovered: 0,
      probes: 0,
    };
    for (const quota of [64, 256, 1024]) {
      const domain = operations.resolveDomain(queryFor(quota));
      const columns = Math.sqrt(quota);
      for (const seed of [
        1, 7, 42, 97, 0x51a7, 0x71eaf, 0x12345678, 0x6d2b79f5,
      ]) {
        const rng = new SeededRandom(seed);
        const strata = [];
        const iid = [];
        const strataBins = new Set<number>();
        const iidBins = new Set<number>();
        for (let index = 0; index < quota; index++) {
          const u = rng.random();
          const v = rng.random();
          const point = sample(domain, index, u, v);
          const x = point.x / 25 + 0.5;
          const z = point.z / 25 + 0.5;
          strata.push({ x, z });
          iid.push({ x: u, z: v });
          strataBins.add(
            Math.floor(x * columns) + Math.floor(z * columns) * columns,
          );
          iidBins.add(
            Math.floor(u * columns) + Math.floor(v * columns) * columns,
          );
        }
        expect(strata).toHaveLength(quota);
        expect(iid).toHaveLength(quota);
        totals.strataEmpty += quota - strataBins.size;
        totals.iidEmpty += quota - iidBins.size;
        totals.bins += quota;
        // Offset fixed probes avoid selecting stratum centers. Euclidean
        // distances remain bounded within the same unwrapped finite cell.
        for (let probeZ = 0; probeZ < 24; probeZ++)
          for (let probeX = 0; probeX < 24; probeX++) {
            const x = (probeX + 0.37) / 24;
            const z = (probeZ + 0.61) / 24;
            let strataNearest = Infinity;
            let iidNearest = Infinity;
            for (let index = 0; index < quota; index++) {
              const a = strata[index];
              const b = iid[index];
              strataNearest = Math.min(
                strataNearest,
                (a.x - x) ** 2 + (a.z - z) ** 2,
              );
              iidNearest = Math.min(
                iidNearest,
                (b.x - x) ** 2 + (b.z - z) ** 2,
              );
            }
            totals.strataNearestSquared += strataNearest * quota;
            totals.iidNearestSquared += iidNearest * quota;
            totals.strataUncovered += Number(strataNearest * quota > 0.85 ** 2);
            totals.iidUncovered += Number(iidNearest * quota > 0.85 ** 2);
            totals.probes++;
          }
      }
    }
    expect(totals.strataEmpty).toBe(0);
    expect(totals.iidEmpty / totals.bins).toBeGreaterThan(0.2);
    expect(totals.iidEmpty / totals.bins).toBeLessThan(0.5);
    expect(totals.strataNearestSquared).toBeGreaterThan(0);
    expect(totals.strataNearestSquared).toBeLessThan(
      totals.iidNearestSquared * 0.95,
    );
    expect(totals.strataUncovered).toBeLessThan(totals.iidUncovered);
    expect(totals.probes).toBe(3 * 8 * 24 * 24);
  });
});
