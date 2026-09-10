import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import { World } from "../../../../core/World";
import { resolveDuelArenaFloorHeight } from "../../../../data/arena-grading";
import type { FlatZone } from "../../../../types/world/terrain";
import {
  createAuthoredTerrainSurfaceOperations,
  type AuthoredTerrainZone,
} from "../AuthoredTerrainSurface";
import { resolveRadialPondTerrainHeight } from "../RadialPondTerrainProfile";
import { TerrainSystem } from "../TerrainSystem";

const operations = createAuthoredTerrainSurfaceOperations();
const noFloors = new Set<string>();
const rawHeight = () => 60;

function zone(
  overrides: Partial<AuthoredTerrainZone> = {},
): AuthoredTerrainZone {
  return {
    id: "grade",
    centerX: 350,
    centerZ: 320,
    width: 10,
    depth: 10,
    height: 20,
    blendRadius: 2,
    ...overrides,
  };
}

function pond(
  overrides: Partial<AuthoredTerrainZone> = {},
): AuthoredTerrainZone {
  return zone({
    id: "pond",
    width: 22,
    depth: 22,
    height: 26.6,
    radialPond: {
      bedRadius: 5,
      bankInnerRadius: 7,
      bankOuterRadius: 9,
      bankHeight: 28.08,
      shorelineAmplitude: 0.9,
    },
    ...overrides,
  });
}

function height(zones: readonly AuthoredTerrainZone[], dx = 0, dz = 0) {
  return operations.resolveHeight(
    zones,
    350 + dx,
    320 + dz,
    rawHeight,
    noFloors,
    null,
  );
}

type SurfaceQuery = { x: number; z: number; proceduralHeight: number };
type WorkerInput = {
  zones: AuthoredTerrainZone[];
  arenaFloorIds: Set<string>;
  arenaGradeHeight: number | null;
  queries: SurfaceQuery[];
};
type SurfaceResult = { height: number | null; excluded: boolean };

/** Real worker, fresh production factory source, structured-clone inputs. */
async function runWorker(
  factorySource: string,
  input: WorkerInput,
): Promise<SurfaceResult[]> {
  const worker = new Worker(
    `
      const { parentPort } = require("node:worker_threads");
      const operations = (${factorySource})();
      parentPort.on("message", input => {
        try {
          const results = input.queries.map(query => ({
            height: operations.resolveHeight(
              input.zones, query.x, query.z, () => query.proceduralHeight,
              input.arenaFloorIds, input.arenaGradeHeight
            ),
            excluded: operations.isGrassExcluded(input.zones, query.x, query.z)
          }));
          parentPort.postMessage({ results });
        } catch (error) {
          parentPort.postMessage({ error: String(error) });
        }
      });
    `,
    { eval: true, env: {} },
  );
  try {
    return await new Promise<SurfaceResult[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Surface worker timed out")),
        5000,
      );
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once(
        "message",
        (message: { results: SurfaceResult[]; error?: string }) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error));
          else resolve(message.results);
        },
      );
      worker.postMessage(input);
    });
  } finally {
    await worker.terminate();
  }
}

function workerFixture(): WorkerInput {
  const tiles = [
    { x: 365, z: 320 },
    { x: 365, z: 321 },
    { x: 366, z: 320 },
  ];
  return {
    zones: [
      zone({
        id: "campus",
        width: 72,
        depth: 72,
        blendRadius: 12,
        excludeGrass: false,
      }),
      pond({ excludeGrass: false }),
      zone({ id: "pad", centerX: 340, width: 2, depth: 2, height: 22 }),
      zone({
        id: "mask",
        centerX: 366,
        centerZ: 321,
        width: 2,
        depth: 2,
        height: 23,
        blendRadius: 0.25,
        tileMask: new Set(tiles.map((tile) => `${tile.x},${tile.z}`)),
        tileMaskTiles: tiles,
        tileMaskBounds: { minX: 365, maxX: 366, minZ: 320, maxZ: 321 },
      }),
      zone({ id: "floor", centerX: 370, height: 20.4, carveInset: 1 }),
    ],
    arenaFloorIds: new Set(["floor"]),
    arenaGradeHeight: 20,
    queries: Array.from({ length: 61 }, (_, ix) =>
      Array.from({ length: 21 }, (_, iz) => ({
        x: 330 + ix,
        z: 310 + iz,
        proceduralHeight: 10 + ix * 0.1 - iz * 0.2,
      })),
    ).flat(),
  };
}

function expectedWorker(input: WorkerInput): SurfaceResult[] {
  return input.queries.map((query) => ({
    height: operations.resolveHeight(
      input.zones,
      query.x,
      query.z,
      () => query.proceduralHeight,
      input.arenaFloorIds,
      input.arenaGradeHeight,
    ),
    excluded: operations.isGrassExcluded(input.zones, query.x, query.z),
  }));
}

describe("authored terrain surface operations", () => {
  it("leaves untouched points null and lazily avoids procedural sampling", () => {
    let calls = 0;
    const raw = () => {
      calls++;
      return 60;
    };
    expect(
      operations.resolveHeight([], 350, 320, raw, noFloors, null),
    ).toBeNull();
    expect(
      operations.resolveHeight(
        [zone({ height: 0 })],
        350,
        320,
        raw,
        noFloors,
        null,
      ),
    ).toBe(0);
    expect(
      operations.resolveHeight([pond()], 350, 320, raw, noFloors, null),
    ).toBe(26.6);
    expect(calls).toBe(0);
    expect(
      operations.resolveHeight([zone()], 356, 320, raw, noFloors, null),
    ).toBe(40);
    expect(calls).toBe(1);
  });

  it("retains rectangular core, smooth blend, and inclusive outer boundary", () => {
    const zones = [zone()];
    expect(height(zones, 5, 5)).toBe(20);
    expect(height(zones, 6, 5)).toBe(40);
    expect(height(zones, 6, 6)).toBe(40);
    expect(height(zones, 7, 7)).toBe(60);
    expect(height(zones, 7.00001)).toBeNull();
    expect(height([zone({ blendRadius: 0 })], 5)).toBe(20);
    expect(height([zone({ blendRadius: 0 })], 5.00001)).toBeNull();
  });

  it("preserves first tied core/blend candidates and normalized nearest-core ranking", () => {
    const first = zone({ id: "first", height: 0 });
    const second = zone({ id: "second", height: 10 });
    expect(height([first, second])).toBe(0);
    expect(height([second, first])).toBe(10);
    expect(height([first, second], 6)).toBe(30);
    expect(height([second, first], 6)).toBe(35);
    const broad = zone({ id: "broad", width: 100, depth: 100, height: 50 });
    expect(height([first, broad], 4)).toBe(50);
    expect(height([broad, first], 4)).toBe(50);
  });

  it("uses exact concave tile masks and their blend bounds, including negative tiles", () => {
    const tiles = [
      { x: -1, z: 0 },
      { x: -1, z: 1 },
      { x: 0, z: 0 },
    ];
    const mask = zone({
      centerX: 0,
      centerZ: 1,
      width: 2,
      depth: 2,
      blendRadius: 0.25,
      tileMask: new Set(tiles.map((tile) => `${tile.x},${tile.z}`)),
      tileMaskTiles: tiles,
      tileMaskBounds: { minX: -1, maxX: 0, minZ: 0, maxZ: 1 },
    });
    const sample = (x: number, z: number) =>
      operations.resolveHeight([mask], x, z, rawHeight, noFloors, null);
    expect(sample(-0.5, 1.5)).toBe(20);
    expect(sample(0.5, 1.5)).toBeNull();
    expect(sample(1.125, 0.5)).toBe(40);
    expect(sample(1.25, 0.5)).toBe(60);
    expect(sample(1.25001, 0.5)).toBeNull();
    expect(operations.isGrassExcluded([mask], 0.5, 1.5)).toBe(false);
    expect(operations.isGrassExcluded([mask], -0.5, 1.5)).toBe(true);
    expect(operations.isGrassExcluded([mask], 1.25, 0.5)).toBe(true);
  });

  it("does not turn an empty tile mask into a rectangular grade or exclusion", () => {
    const empty = zone({ tileMask: new Set(), tileMaskTiles: [] });
    expect(height([empty])).toBeNull();
    expect(operations.isGrassExcluded([empty], 350, 320)).toBe(false);
  });

  it("matches the existing radial resolver through every ring and lazy fallback", () => {
    const radial = pond();
    for (const radius of [0, 5, 5.5, 6, 7, 8, 9, 9.5, 10, 10.99999, 11, 12]) {
      for (let step = 0; step < 16; step++) {
        const angle = (step * Math.PI) / 8;
        const x = radial.centerX + Math.cos(angle) * radius;
        const z = radial.centerZ + Math.sin(angle) * radius;
        expect(
          operations.resolveRadialPondTerrainHeight(radial, x, z, rawHeight),
        ).toBe(resolveRadialPondTerrainHeight(radial, x, z, rawHeight));
      }
    }
    expect(
      operations.resolveRadialPondTerrainHeight(zone(), 350, 320, rawHeight),
    ).toBeNull();
  });

  it("keeps radial priority while blending to winning underlying core, blend or floor", () => {
    const radial = pond();
    const broad = zone({ id: "campus", width: 60, depth: 60, height: 0 });
    expect(height([radial, broad], 10)).toBe(14.04);
    expect(height([broad, radial], 10)).toBe(14.04);
    expect(height([radial, broad], 11)).toBe(0);
    const blend = zone({ id: "blend", width: 18, height: 20 });
    expect(height([radial, blend], 10)).toBe((28.08 + 40) / 2);
    const floor = zone({ id: "floor", width: 40, depth: 40, height: 20.4 });
    expect(
      operations.resolveHeight(
        [radial, broad, floor],
        360,
        320,
        rawHeight,
        new Set(["floor"]),
        20,
      ),
    ).toBe((28.08 + 20.4) / 2);
    expect(height([radial], 10)).toBe((28.08 + 60) / 2);
  });

  it("preserves nearest radial choice and first ties independently of core order", () => {
    const first = pond({ id: "first" });
    const second = pond({ id: "second", centerX: 352, height: 25 });
    expect(height([first, second], 1)).toBe(26.6);
    expect(height([second, first], 1)).toBe(25);
    expect(height([first, second], 1.1)).toBe(25);
    expect(height([second, first], 0.9)).toBe(26.6);
  });

  it("preserves exact owned floor ramps, highest overlays and null-base fallback", () => {
    const floor = zone({
      id: "floor",
      height: 20.4,
      blendRadius: 1,
      carveInset: 1,
    });
    const campus = zone({ id: "campus", width: 100, depth: 100, height: 20 });
    for (const dx of [0, 4, 5, 5.25, 5.5, 6, 6.00001]) {
      for (const dz of [0, 5.5, 6]) {
        expect(
          operations.resolveDuelArenaFloorHeight(floor, 350 + dx, 320 + dz, 20),
        ).toBe(resolveDuelArenaFloorHeight(floor, 350 + dx, 320 + dz, 20));
      }
    }
    const owned = new Set(["floor", "higher"]);
    expect(
      operations.resolveHeight([campus, floor], 355, 325, rawHeight, owned, 20),
    ).toBe(20.4);
    expect(
      operations.resolveHeight(
        [floor, campus],
        355.5,
        320,
        rawHeight,
        owned,
        20,
      ),
    ).toBe(20.2);
    expect(
      operations.resolveHeight(
        [campus, floor],
        355,
        320,
        rawHeight,
        owned,
        null,
      ),
    ).toBe(20);
    expect(
      operations.resolveHeight(
        [floor, zone({ ...floor, id: "higher", height: 21 })],
        350,
        320,
        rawHeight,
        owned,
        20,
      ),
    ).toBe(21);
  });

  it("defaults to exclusion, permits natural grades, and lets every explicit pad win", () => {
    const allowed = zone({
      id: "natural",
      width: 100,
      depth: 100,
      excludeGrass: false,
    });
    const pad = zone({ id: "station", excludeGrass: true });
    expect(operations.isGrassExcluded([allowed], 350, 320)).toBe(false);
    for (const zones of [
      [allowed, pad],
      [pad, allowed],
      [allowed, zone()],
    ]) {
      expect(operations.isGrassExcluded(zones, 350, 320)).toBe(true);
      expect(operations.isGrassExcluded(zones, 357, 320)).toBe(true);
      expect(operations.isGrassExcluded(zones, 357.00001, 320)).toBe(false);
    }
    expect(height([allowed])).toBe(20);
  });

  it("uses a radial grass exclusion, not the enclosing pond rectangle", () => {
    expect(operations.isGrassExcluded([pond()], 360, 330)).toBe(false);
    expect(operations.isGrassExcluded([pond()], 360.99999, 320)).toBe(true);
    expect(operations.isGrassExcluded([pond()], 361, 320)).toBe(false);
    expect(
      operations.isGrassExcluded([pond({ excludeGrass: false })], 350, 320),
    ).toBe(false);
  });

  it("matches actual TerrainSystem authored candidates and normal stencils without a renderer", () => {
    const world = Object.assign(new World(), { config: { terrainSeed: 0 } });
    const terrain = new TerrainSystem(world);
    const internal = terrain as unknown as {
      initializeTerrainGenerator(): void;
      loadFlatZonesFromManifest(): void;
      getFlatZoneHeight(x: number, z: number): number | null;
      flatZones: Map<string, FlatZone>;
      flatZonesByTile: Map<string, FlatZone[]>;
      arenaFloorZoneIds: Set<string>;
      arenaGradeHeight: number | null;
    };
    internal.initializeTerrainGenerator();
    internal.loadFlatZonesFromManifest();
    const tileSize = terrain.getWorldTerrainProfile().terrainTileSize;
    const candidates = (x: number, z: number) => {
      const tileX = Math.floor((x + tileSize / 2) / tileSize);
      const tileZ = Math.floor((z + tileSize / 2) / tileSize);
      const found = new Map<string, FlatZone>();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const candidate of internal.flatZonesByTile.get(
            `${tileX + dx}_${tileZ + dz}`,
          ) ?? []) {
            if (!found.has(candidate.id)) found.set(candidate.id, candidate);
          }
        }
      }
      return [...found.values()];
    };
    const resolved = (x: number, z: number) =>
      operations.resolveHeight(
        candidates(x, z),
        x,
        z,
        () => terrain.getProceduralHeightAt(x, z),
        internal.arenaFloorZoneIds,
        internal.arenaGradeHeight,
      );
    const final = (x: number, z: number) =>
      resolved(x, z) ?? terrain.getProceduralHeightAt(x, z);
    expect(internal.flatZones.size).toBeGreaterThan(10);
    for (const candidate of internal.flatZones.values()) {
      for (const factor of [0, 0.5, 1, 1.001]) {
        const x =
          candidate.centerX +
          factor * (candidate.width / 2 + candidate.blendRadius);
        const z =
          candidate.centerZ +
          factor * (candidate.depth / 2 + candidate.blendRadius);
        for (const [dx, dz] of [
          [0, 0],
          [-0.5, 0],
          [0.5, 0],
          [0, -0.5],
          [0, 0.5],
        ]) {
          expect(resolved(x + dx, z + dz)).toBe(
            internal.getFlatZoneHeight(x + dx, z + dz),
          );
          expect(final(x + dx, z + dz)).toBeCloseTo(
            terrain.getHeightAt(x + dx, z + dz),
            10,
          );
        }
        const nx = final(x - 0.5, z) - final(x + 0.5, z);
        const nz = final(x, z - 0.5) - final(x, z + 0.5);
        const length = Math.hypot(nx, 1, nz);
        expect(Math.hypot(nx / length, 1 / length, nz / length)).toBeCloseTo(
          1,
          12,
        );
      }
    }
  });

  it("runs freshly generated factory source in a real worker with structured-clone masks", async () => {
    const input = workerFixture();
    expect(
      await runWorker(createAuthoredTerrainSurfaceOperations.toString(), input),
    ).toEqual(expectedWorker(input));
  });

  it("remains self-contained after the installed esbuild bundles with keepNames and minification", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../AuthoredTerrainSurface.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "iife",
      globalName: "AuthoredSurfaceBundle",
      keepNames: true,
      minify: true,
    });
    const factorySource = runInNewContext(
      `${result.outputFiles[0].text}\nAuthoredSurfaceBundle.createAuthoredTerrainSurfaceOperations.toString()`,
    ) as string;
    const input = workerFixture();
    expect(await runWorker(factorySource, input)).toEqual(
      expectedWorker(input),
    );
  });
});
