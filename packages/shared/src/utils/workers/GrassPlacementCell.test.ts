import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  createGrassPlacementCellOperations,
  getGrassPlacementCellBounds,
  type GrassPlacementCell,
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
