import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { World } from "../../core/World";
import type { FlatZone } from "../../types/world/terrain";
import { TerrainSystem } from "../../systems/shared/world/TerrainSystem";
import { WaterBodyRegistry } from "../../systems/shared/world/WaterBodyRegistry";
import { validateRadialPondTerrainProfile } from "../../systems/shared/world/RadialPondTerrainProfile";
import {
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  createGrassTerrainSurfaceOperations,
  createGrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceZone,
  type GrassTerrainWaterBody,
} from "./GrassTerrainSurfaceSnapshot";

const operations = createGrassTerrainSurfaceOperations();

function zone(
  overrides: Partial<GrassTerrainSurfaceZone> = {},
): GrassTerrainSurfaceZone {
  return {
    id: "grade",
    centerX: 0,
    centerZ: 0,
    width: 20,
    depth: 20,
    height: 24,
    blendRadius: 4,
    ...overrides,
  };
}

function masked(): GrassTerrainSurfaceZone {
  return zone({
    id: "L-footprint",
    tileMask: new Set(["-1,0", "0,0", "0,1"]),
    tileMaskTiles: [
      { x: -1, z: 0 },
      { x: 0, z: 0 },
      { x: 0, z: 1 },
    ],
    tileMaskBounds: { minX: -1, maxX: 0, minZ: 0, maxZ: 1 },
  });
}

function snapshot(
  zones: GrassTerrainSurfaceZone[] = [zone()],
): GrassTerrainSurfaceSnapshot {
  return {
    schemaVersion: 1,
    zones,
    arenaFloorIds: [],
    arenaGradeHeight: null,
    waterBodies: [],
  };
}

type WorkerReceipt = {
  error?: string;
  snapshot: GrassTerrainSurfaceSnapshot;
  water: number[];
  candidateIds: string[][];
  indexedZoneReferences: number;
};

/** Real Node worker and native structured clone; no game or transport mocks. */
function actualWorker(
  factorySource = createGrassTerrainSurfaceOperations.toString(),
) {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    const operations = (${factorySource})();
    parentPort.on("message", input => {
      try {
        const snapshot = operations.validateSnapshot(input.snapshot);
        const index = operations.createZoneIndex(snapshot, input.tileSize ?? 100);
        const points = input.points ?? [];
        parentPort.postMessage({ snapshot, indexedZoneReferences: index.indexedZoneReferences,
          water: points.map(p => operations.getWaterSurfaceAt(snapshot, input.oceanLevel ?? 16, p[0], p[1])),
          candidateIds: points.map(p => index.getZonesAt(p[0], p[1]).map(z => z.id)) });
      } catch (error) { parentPort.postMessage({ error: String(error.message) }); }
    });
  `,
    { eval: true, env: {} },
  );
  return {
    execute(input: unknown): Promise<WorkerReceipt> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Snapshot worker timed out")),
          5000,
        );
        const onError = (error: Error) => finish(error);
        const onExit = (code: number) =>
          finish(new Error("Snapshot worker exited before receipt: " + code));
        const onMessage = (receipt: WorkerReceipt) => finish(null, receipt);
        function finish(error: Error | null, receipt?: WorkerReceipt) {
          clearTimeout(timer);
          worker.off("error", onError);
          worker.off("exit", onExit);
          worker.off("message", onMessage);
          if (error) reject(error);
          else resolve(receipt!);
        }
        worker.once("error", onError);
        worker.once("exit", onExit);
        worker.once("message", onMessage);
        try {
          worker.postMessage(input);
        } catch (error) {
          finish(error as Error);
        }
      });
    },
    close: () => worker.terminate(),
  };
}

describe("detached grass terrain surface requests", () => {
  it("deep-clones wire fields and preserves radial, masked and false-exclusion geometry", () => {
    const radial = zone({
      id: "pond",
      width: 30,
      depth: 30,
      height: 21,
      blendRadius: 4,
      radialPond: {
        bedRadius: 3,
        bankInnerRadius: 5,
        bankOuterRadius: 7,
        bankHeight: 24,
        shorelineAmplitude: 0.6,
      },
    });
    const input = snapshot([
      zone({ excludeGrass: false, carveInset: 0 }),
      radial,
      masked(),
    ]);
    input.arenaFloorIds.push("grade");
    input.arenaGradeHeight = 23.6;
    input.waterBodies.push({
      id: "pond-water",
      centerX: 0,
      centerZ: 0,
      radius: 6,
      surfaceY: 23,
    });
    const expected = structuredClone(input);
    const clone = createGrassTerrainSurfaceSnapshot(input);
    input.zones[0].height = 999;
    radial.radialPond!.bankHeight = 888;
    radial.radialPond!.shorelineAmplitude = 0.1;
    input.zones[2].tileMask!.clear();
    input.zones[2].tileMaskTiles![0].x = 555;
    input.zones[2].tileMaskBounds!.minX = 444;
    input.waterBodies[0].surfaceY = 777;
    input.arenaFloorIds.length = 0;
    input.zones.length = 0;
    expect(clone).toEqual(expected);
    expect(clone.zones[2].tileMask).toBeInstanceOf(Set);
    expect(GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE).toBe(0.5);
  });

  it("preserves valid absent list/bounds and empty-mask semantics without synthesis", () => {
    const cases = [
      zone({ tileMask: new Set(["1,-2"]) }),
      zone({ tileMask: new Set<string>() }),
      zone({ tileMask: new Set<string>(), tileMaskTiles: [] }),
      zone({ tileMask: new Set(["1,-2"]), tileMaskTiles: [{ x: 1, z: -2 }] }),
      zone({
        tileMask: new Set(["1,-2"]),
        tileMaskBounds: { minX: 1, maxX: 1, minZ: -2, maxZ: -2 },
      }),
      zone({
        tileMaskTiles: [{ x: 1, z: -2 }],
        tileMaskBounds: { minX: 1, maxX: 1, minZ: -2, maxZ: -2 },
      }),
    ];
    for (const source of cases) {
      const clone = createGrassTerrainSurfaceSnapshot(snapshot([source]))
        .zones[0];
      expect(clone).toEqual(source);
      expect(Object.hasOwn(clone, "tileMaskTiles")).toBe(
        Object.hasOwn(source, "tileMaskTiles"),
      );
      expect(Object.hasOwn(clone, "tileMaskBounds")).toBe(
        Object.hasOwn(source, "tileMaskBounds"),
      );
    }
  });

  it("rejects non-finite or invalid geometry, duplicate IDs and malformed arena ownership", () => {
    const invalid: unknown[] = [
      { ...snapshot(), schemaVersion: 2 },
      snapshot([zone({ centerX: NaN })]),
      snapshot([zone({ height: Infinity })]),
      snapshot([zone({ width: 0 })]),
      snapshot([zone({ depth: -1 })]),
      snapshot([zone({ blendRadius: -1 })]),
      snapshot([zone({ carveInset: -1 })]),
      { ...snapshot(), zones: [{ ...zone(), excludeGrass: "false" }] },
      snapshot([zone(), zone()]),
      { ...snapshot(), arenaFloorIds: ["missing"], arenaGradeHeight: 24 },
      {
        ...snapshot(),
        arenaFloorIds: ["grade", "grade"],
        arenaGradeHeight: 24,
      },
      { ...snapshot(), arenaFloorIds: ["grade"] },
      { ...snapshot(), arenaGradeHeight: NaN },
      {
        ...snapshot([masked()]),
        arenaFloorIds: ["L-footprint"],
        arenaGradeHeight: 24,
      },
      { ...snapshot(), zones: [{ ...zone(), id: "x".repeat(129) }] },
    ];
    for (const input of invalid)
      expect(() => operations.validateSnapshot(input)).toThrow(
        /Invalid grass terrain surface/,
      );
  });

  it("requires canonical unique mask/list correspondence and exact inclusive bounds when supplied", () => {
    const invalid = [
      { tileMask: ["0,0"] },
      { tileMask: new Set(["-0,0"]) },
      { tileMask: new Set(["1.2,0"]) },
      { tileMask: new Set(["0,NaN"]) },
      { tileMask: new Set(["9007199254740991,0"]) },
      { tileMask: new Set(["0,0"]), tileMaskTiles: [] },
      { tileMask: new Set(["0,0"]), tileMaskTiles: [{ x: 1, z: 0 }] },
      {
        tileMaskTiles: [
          { x: 0, z: 0 },
          { x: 0, z: 0 },
        ],
      },
      {
        tileMask: new Set(["0,0"]),
        tileMaskBounds: { minX: -1, maxX: 0, minZ: 0, maxZ: 0 },
      },
      {
        tileMask: new Set(),
        tileMaskBounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      },
      { tileMaskBounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } },
    ];
    for (const fields of invalid)
      expect(() =>
        operations.validateSnapshot({
          ...snapshot(),
          zones: [{ ...zone(), ...fields }],
        }),
      ).toThrow();
  });

  it("matches the existing radial-profile validator and rejects ambiguous mask/radial geometry", () => {
    const base = zone({
      width: 30,
      depth: 30,
      height: 21,
      blendRadius: 4,
      radialPond: {
        bedRadius: 3,
        bankInnerRadius: 5,
        bankOuterRadius: 7,
        bankHeight: 24,
      },
    });
    expect(validateRadialPondTerrainProfile(base)).toBeNull();
    expect(operations.validateSnapshot(snapshot([base])).zones[0]).toBe(base);
    for (const changes of [
      { bedRadius: 0 },
      { bedRadius: NaN },
      { bankInnerRadius: 3 },
      { bankOuterRadius: 4 },
      { bankHeight: 21 },
      { shorelineAmplitude: NaN },
      { shorelineAmplitude: -0.1 },
      { shorelineAmplitude: 0.751 },
    ]) {
      const invalid = {
        ...base,
        radialPond: { ...base.radialPond!, ...changes },
      };
      expect(validateRadialPondTerrainProfile(invalid)).not.toBeNull();
      expect(() => operations.validateSnapshot(snapshot([invalid]))).toThrow();
    }
    for (const changes of [{ width: 21 }, { depth: 21 }, { blendRadius: 0 }]) {
      const invalid = { ...base, ...changes };
      expect(validateRadialPondTerrainProfile(invalid)).not.toBeNull();
      expect(() => operations.validateSnapshot(snapshot([invalid]))).toThrow();
    }
    expect(() =>
      operations.validateSnapshot(snapshot([{ ...base, tileMask: new Set() }])),
    ).toThrow(/radial pond cannot/);
  });

  it("admits ceilings and rejects zone, water and aggregate mask limits", () => {
    const manyZones = Array.from(
      { length: operations.limits.maxZones },
      (_, i) => zone({ id: String(i) }),
    );
    expect(operations.validateSnapshot(snapshot(manyZones)).zones).toHaveLength(
      512,
    );
    expect(() =>
      operations.validateSnapshot(
        snapshot([...manyZones, zone({ id: "overflow" })]),
      ),
    ).toThrow(/zones array bound/);
    const waterBodies = Array.from(
      { length: operations.limits.maxWaterBodies },
      (_, i) => ({
        id: String(i),
        centerX: 0,
        centerZ: 0,
        radius: 1,
        surfaceY: 20,
      }),
    );
    expect(
      operations.validateSnapshot({ ...snapshot(), waterBodies }).waterBodies,
    ).toHaveLength(128);
    expect(() =>
      operations.validateSnapshot({
        ...snapshot(),
        waterBodies: [...waterBodies, { ...waterBodies[0], id: "overflow" }],
      }),
    ).toThrow(/waterBodies array bound/);
    const tileMask = new Set(Array.from({ length: 32768 }, (_, i) => `${i},0`));
    const large = zone({ tileMask });
    expect(
      operations.validateSnapshot(snapshot([large])).zones[0].tileMask?.size,
    ).toBe(32768);
    expect(() =>
      operations.validateSnapshot(
        snapshot([large, zone({ id: "second", tileMask: new Set(["0,0"]) })]),
      ),
    ).toThrow(/total mask tile bound/);
    tileMask.add("32768,0");
    expect(() => operations.validateSnapshot(snapshot([large]))).toThrow(
      /tile mask bound/,
    );
  });

  it("round-trips native Sets in an actual worker and rejects malformed requests there", async () => {
    const worker = actualWorker();
    try {
      const source = createGrassTerrainSurfaceSnapshot(
        snapshot([masked(), zone({ id: "plain", excludeGrass: false })]),
      );
      const pending = worker.execute({
        snapshot: source,
        points: [
          [0, 0],
          [400, 400],
        ],
      });
      source.zones[0].tileMask!.clear();
      const receipt = await pending;
      expect(receipt.error).toBeUndefined();
      expect(receipt.snapshot.zones[0].tileMask).toEqual(
        new Set(["-1,0", "0,0", "0,1"]),
      );
      expect(receipt.water).toEqual([16, 16]);
      expect(receipt.candidateIds).toEqual([["L-footprint", "plain"], []]);
      const invalid: unknown[] = [
        snapshot([zone({ height: NaN })]),
        snapshot([zone(), zone()]),
        {
          ...snapshot(),
          zones: [{ ...masked(), tileMaskTiles: [{ x: 4, z: 4 }] }],
        },
        { ...snapshot(), arenaFloorIds: ["unknown"], arenaGradeHeight: 20 },
      ];
      for (const bad of invalid)
        expect((await worker.execute({ snapshot: bad })).error).toMatch(
          /Invalid grass terrain surface/,
        );
    } finally {
      await worker.close();
    }
  });

  it("remains self-contained after real esbuild keepNames and minification", async () => {
    const source = readFileSync(
      new URL("./GrassTerrainSurfaceSnapshot.ts", import.meta.url),
      "utf8",
    );
    const compiled = transformSync(source, {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      keepNames: true,
      minify: true,
    }).code;
    // Evaluate the transformed module only in a disposable real worker, then send its
    // factory source to another worker with none of the module's lexical environment.
    const extractor = new Worker(
      `const { parentPort } = require("node:worker_threads");
      const module = { exports: {} }; const exports = module.exports;
      ${compiled}
      parentPort.postMessage(module.exports.createGrassTerrainSurfaceOperations.toString());`,
      { eval: true, env: {} },
    );
    let factorySource: string;
    try {
      factorySource = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Factory extraction timed out")),
          5000,
        );
        extractor.once("message", (value: string) => {
          clearTimeout(timer);
          resolve(value);
        });
        extractor.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } finally {
      await extractor.terminate();
    }
    const worker = actualWorker(factorySource);
    try {
      const result = await worker.execute({
        snapshot: snapshot([masked()]),
        points: [[0, 0]],
      });
      expect(result.error).toBeUndefined();
      expect(result.candidateIds).toEqual([["L-footprint"]]);
    } finally {
      await worker.close();
    }
  });
});

describe("real terrain spatial ordering and water parity", () => {
  it("preserves actual TerrainSystem centered bucket ordering for boundary ties and deduplication", () => {
    for (const boundary of [50, -50]) {
      for (const axis of ["x", "z"] as const) {
        const zones = [
          zone({
            id: "registered-first",
            centerX: axis === "x" ? boundary + 10 : 0,
            centerZ: axis === "z" ? boundary + 10 : 0,
            height: 12,
            blendRadius: 0,
          }),
          zone({
            id: "bucket-first",
            centerX: axis === "x" ? boundary - 10 : 0,
            centerZ: axis === "z" ? boundary - 10 : 0,
            height: 34,
            blendRadius: 0,
          }),
        ];
        const terrain = new TerrainSystem(new World());
        try {
          const initialization = terrain as unknown as {
            initializeTerrainGenerator(): void;
          };
          initialization.initializeTerrainGenerator();
          for (const zone of zones) terrain.registerFlatZone(zone);
          const internals = terrain as unknown as {
            getFlatZoneHeight(x: number, z: number): number | null;
            flatZonesByTile: Map<string, FlatZone[]>;
          };
          const index = operations.createZoneIndex(
            createGrassTerrainSurfaceSnapshot(snapshot(zones)),
            terrain.tileSize,
          );
          const x = axis === "x" ? boundary : 0;
          const z = axis === "z" ? boundary : 0;
          expect(index.getZonesAt(x, z).map((zone) => zone.id)).toEqual([
            "bucket-first",
            "registered-first",
          ]);
          expect(internals.getFlatZoneHeight(x, z)).toBe(
            index.getZonesAt(x, z)[0].height,
          );
          expect(internals.getFlatZoneHeight(x, z)).toBe(34);
          expect(index.indexedZoneReferences).toBe(
            [...internals.flatZonesByTile.values()].reduce(
              (total, rows) => total + rows.length,
              0,
            ),
          );
          expect(index.bucketCount).toBe(internals.flatZonesByTile.size);
          expect(
            new Set(index.getZonesAt(x, z).map((zone) => zone.id)).size,
          ).toBe(index.getZonesAt(x, z).length);
          const storage = index.getZonesAt(x, z);
          expect(index.getZonesAt(10000, 10000)).toBe(storage);
          expect(storage).toHaveLength(0);
        } finally {
          terrain.destroy();
        }
      }
    }
  });

  it("bounds index construction at 65,536 references and rejects extreme coordinates before loops", () => {
    const exact = snapshot([
      zone({ width: 25500, depth: 25500, blendRadius: 0 }),
    ]);
    const index = operations.createZoneIndex(
      operations.validateSnapshot(exact),
      100,
    );
    expect(index.indexedZoneReferences).toBe(65536);
    expect(() =>
      operations.createZoneIndex(
        snapshot([zone({ width: 25600, depth: 25600, blendRadius: 0 })]),
        100,
      ),
    ).toThrow(/spatial index reference bound/);
    expect(() =>
      operations.createZoneIndex(
        snapshot([zone({ width: 1e308, depth: 1e308 })]),
        100,
      ),
    ).toThrow(/unsafe spatial index/);
    expect(() =>
      operations.createZoneIndex(snapshot(), Number.MIN_VALUE),
    ).toThrow(/unsafe spatial index/);
    expect(() => operations.createZoneIndex(snapshot(), 0)).toThrow(/positive/);
    expect(() => index.getZonesAt(Infinity, 0)).toThrow(/unsafe spatial query/);
  });

  it("matches actual WaterBodyRegistry overlaps, exact boundaries, negative coordinates and below-ocean bodies", async () => {
    const bodies: GrassTerrainWaterBody[] = [
      { id: "below-ocean", centerX: -10, centerZ: -10, radius: 6, surfaceY: 8 },
      {
        id: "higher-overlap",
        centerX: -6,
        centerZ: -10,
        radius: 3,
        surfaceY: 12,
      },
      { id: "elevated", centerX: 40, centerZ: 30, radius: 7.5, surfaceY: 27.8 },
    ];
    const registry = new WaterBodyRegistry(16);
    for (const body of bodies)
      registry.register({
        ...body,
        radiusSq: body.radius ** 2,
        sourceType: "explicit",
      });
    const input = createGrassTerrainSurfaceSnapshot({
      ...snapshot(),
      waterBodies: registry.getAllBodies(),
    });
    const points = [
      [-10, -10],
      [-6, -10],
      [-16, -10],
      [-16.000001, -10],
      [40, 30],
      [47.5, 30],
      [47.500001, 30],
      [100, 100],
    ];
    const expected = points.map(([x, z]) => registry.getWaterSurfaceAt(x, z));
    expect(expected).toEqual([8, 12, 8, 16, 27.8, 27.8, 16, 16]);
    for (const [x, z] of points)
      expect(operations.getWaterSurfaceAt(input, 16, x, z)).toBe(
        registry.getWaterSurfaceAt(x, z),
      );
    const worker = actualWorker();
    try {
      expect((await worker.execute({ snapshot: input, points })).water).toEqual(
        expected,
      );
    } finally {
      await worker.close();
    }
    for (const waterBodies of [
      [bodies[0], bodies[0]],
      [{ ...bodies[0], radius: 0 }],
      [{ ...bodies[0], surfaceY: NaN }],
      [{ ...bodies[0], radius: 1e308 }],
    ]) {
      expect(() =>
        operations.validateSnapshot({ ...snapshot(), waterBodies }),
      ).toThrow();
    }
  });
});
