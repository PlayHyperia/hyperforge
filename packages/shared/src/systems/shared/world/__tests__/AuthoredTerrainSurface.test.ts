import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import { World } from "../../../../core/World";
import {
  createDuelArenaFloorZones,
  resolveDuelArenaFloorHeight,
} from "../../../../data/arena-grading";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import type { FlatZone } from "../../../../types/world/terrain";
import {
  createAuthoredTerrainSurfaceOperations,
  type AuthoredTerrainZone,
} from "../AuthoredTerrainSurface";
import {
  resolveRadialPondTerrainHeight,
  validateRadialPondTerrainProfile,
} from "../RadialPondTerrainProfile";
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

/** Explicit preview candidate cloned from the loaded manifest, not a mutation
 * or assertion that the frozen source world already contains these sectors. */
function asymmetricPondCandidate(): AuthoredTerrainZone {
  const original = ALL_WORLD_AREAS.haven_pond.flatZones?.find(
    (candidate) => candidate.radialPond,
  );
  if (!original?.radialPond || original.height === undefined)
    throw new Error("Missing loaded Haven pond profile");
  return {
    ...original,
    height: original.height,
    radialPond: {
      ...original.radialPond,
      bankSectors: [
        {
          bearing: (-133 * Math.PI) / 180,
          halfWidth: (40 * Math.PI) / 180,
          innerRadius: 6.25,
          innerHeight: 27.84,
        },
        {
          bearing: (-27 * Math.PI) / 180,
          halfWidth: (24 * Math.PI) / 180,
          innerRadius: 6.55,
          innerHeight: 28.08,
        },
      ],
    },
  };
}

/** Review49 geometry trial only: retain the two historical contact sectors and
 * explicitly add the photographed south-east shoulder. Never edit the loaded
 * manifest or the earlier preview44 fixture to make this candidate pass. */
function review49PondCandidate(): AuthoredTerrainZone {
  const original = asymmetricPondCandidate();
  const profile = original.radialPond!;
  return {
    ...original,
    radialPond: {
      ...profile,
      bankSectors: [
        ...profile.bankSectors!,
        { bearing: 0.7, halfWidth: 0.55, innerRadius: 6.4, innerHeight: 27.86 },
      ],
    },
  };
}

/** Explicit review52 data only; loaded/historical assets remain untouched. */
function review52PondCandidate(): AuthoredTerrainZone {
  const original = review49PondCandidate();
  return {
    ...original,
    radialPond: {
      ...original.radialPond!,
      bankSectors: [
        {
          bearing: -2.321287905152458,
          halfWidth: 0.6981317007977318,
          innerRadius: 6,
          innerHeight: 27.98,
          outerRadius: 8.2,
          outerHeight: 28.55,
        },
        ...original.radialPond!.bankSectors!.slice(1),
        {
          bearing: -1.5533430342749532,
          halfWidth: 0.8726646259971648,
          innerRadius: 7.1,
          innerHeight: 27.86,
          outerRadius: 8.7,
          outerHeight: 27.99,
        },
      ],
    },
  };
}

function unwarpedPairedPond(): AuthoredTerrainZone {
  const candidate = pond({ centerX: 0, centerZ: 0 });
  return {
    ...candidate,
    radialPond: {
      ...candidate.radialPond!,
      shorelineAmplitude: 0,
      bankSectors: [
        {
          bearing: 0,
          halfWidth: 1,
          innerRadius: 6,
          innerHeight: 27.98,
          outerRadius: 8.2,
          outerHeight: 28.55,
        },
      ],
    },
  };
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
      zone({
        id: "rounded-backing",
        centerX: 385,
        width: 4,
        depth: 4,
        blendRadius: 8,
        blendShape: "rounded",
        blendComposition: "smooth-union",
        excludeGrass: false,
      }),
      zone({
        id: "bounded-grass-only",
        centerX: 348,
        centerZ: 307,
        width: 8,
        depth: 4,
        blendRadius: 1,
        grassExclusionBounds: { minX: 347, maxX: 350, minZ: 308, maxZ: 309 },
      }),
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

  it("rounds only opt-in rectangle blends with true metre distance and unchanged cores", () => {
    const square = zone({ width: 10, depth: 4, blendRadius: 5 });
    const rounded = zone({ ...square, blendShape: "rounded" });
    for (let dx = -11; dx <= 11; dx += 0.25)
      for (let dz = -8; dz <= 8; dz += 0.25) {
        const outsideX = Math.max(0, Math.abs(dx) - 5);
        const outsideZ = Math.max(0, Math.abs(dz) - 2);
        for (const [candidate, distance] of [
          [square, Math.max(outsideX, outsideZ)],
          [rounded, Math.hypot(outsideX, outsideZ)],
        ] as const) {
          const t = distance / 5;
          const expected = distance > 5 ? null : 20 + 40 * t * t * (3 - 2 * t);
          const actual = height([candidate], dx, dz);
          if (expected === null) expect(actual).toBeNull();
          else expect(actual).toBeCloseTo(expected, 12);
          expect(
            operations.isGrassExcluded([candidate], 350 + dx, 320 + dz),
          ).toBe(distance <= 5);
        }
      }
    expect(height([rounded], 8, 6)).toBe(60); // Exact 3-4-5 corner boundary.
    expect(height([rounded], 8.000001, 6)).toBeNull();
    expect(height([square], 10, 7)).toBe(60);
    expect(height([rounded], 10, 7)).toBeNull();
    expect(
      height([zone({ blendShape: "rounded", blendRadius: 0 })], 5, 5),
    ).toBe(20);
    expect(
      height([zone({ blendShape: "rounded", blendRadius: 0 })], 5.00001),
    ).toBeNull();
  });

  it("preserves every actual duel-floor collar with separate rounded functional backing", () => {
    const base = 28.419301523097687;
    const floors = createDuelArenaFloorZones(getDuelArenaConfig(), base);
    const floorIds = new Set(floors.map((floor) => floor.id));
    const backing = floors.map((floor) =>
      zone({
        id: `${floor.id}-functional-backing`,
        centerX: floor.centerX,
        centerZ: floor.centerZ,
        width: floor.width + 2 * floor.blendRadius,
        depth: floor.depth + 2 * floor.blendRadius,
        height: base,
        blendRadius: 24,
        blendShape: "rounded",
        blendComposition: "smooth-union",
        excludeGrass: false,
      }),
    );
    expect(
      backing.map(({ centerX, centerZ, width, depth }) => ({
        minX: centerX - width / 2,
        maxX: centerX + width / 2,
        minZ: centerZ - depth / 2,
        maxZ: centerZ + depth / 2,
      })),
    ).toEqual([
      { minX: 339, maxX: 361, minZ: 393, maxZ: 419 },
      { minX: 375, maxX: 395, minZ: 367, maxZ: 385 },
      { minX: 338, maxX: 352, minZ: 369, maxZ: 383 },
    ]);
    for (const floor of floors) {
      expect(floor).not.toHaveProperty("blendShape");
      for (let dx = -floor.width / 2 - 1; dx <= floor.width / 2 + 1; dx += 0.25)
        for (
          let dz = -floor.depth / 2 - 1;
          dz <= floor.depth / 2 + 1;
          dz += 0.25
        ) {
          const x = floor.centerX + dx,
            z = floor.centerZ + dz;
          expect(
            operations.resolveHeight(
              [...backing, ...floors],
              x,
              z,
              () => 10,
              floorIds,
              base,
            ),
          ).toBe(resolveDuelArenaFloorHeight(floor, x, z, base));
        }
      const z = floor.centerZ + floor.depth / 2 + 1;
      const inside = operations.resolveHeight(
        [...backing, ...floors],
        floor.centerX,
        z,
        () => 10,
        floorIds,
        base,
      );
      const outside = operations.resolveHeight(
        [...backing, ...floors],
        floor.centerX,
        z + 1e-5,
        () => 10,
        floorIds,
        base,
      );
      expect(inside).toBe(base);
      expect(outside).toBeCloseTo(base, 8);
    }
  });

  it("smoothly unions explicitly opted same-datum backing at the actual arena/lobby overlap", async () => {
    const datum = 28.419301523097687;
    const backings = [
      zone({
        id: "arena",
        centerX: 350,
        centerZ: 406,
        width: 22,
        depth: 26,
        height: datum,
        blendRadius: 24,
        blendShape: "rounded",
        blendComposition: "smooth-union",
        excludeGrass: false,
      }),
      zone({
        id: "lobby",
        centerX: 385,
        centerZ: 376,
        width: 20,
        depth: 18,
        height: datum,
        blendRadius: 24,
        blendShape: "rounded",
        blendComposition: "smooth-union",
        excludeGrass: false,
      }),
    ];
    const sample = (x: number, z: number) =>
      operations.resolveHeight(backings, x, z, () => 25, noFloors, null)!;
    const factor = 2 / 3;
    const outside = factor * factor * (3 - 2 * factor);
    expect(sample(377, 401)).toBe(datum + (25 - datum) * (outside * outside));
    const e = 1e-4;
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [1, -1],
    ]) {
      // Differentiate the independent product at f=g=2/3. Each one-sided
      // finite difference has a curvature truncation term; it must converge
      // to this same derivative rather than merely agree with the other side.
      const expectedDerivative =
        (25 - datum) * ((6 * factor * (1 - factor)) / 24) * outside * (dx + dz);
      let previousError = Infinity;
      for (const step of [e, e / 2]) {
        const left =
          (sample(377, 401) - sample(377 - dx * step, 401 - dz * step)) / step;
        const right =
          (sample(377 + dx * step, 401 + dz * step) - sample(377, 401)) / step;
        const error = Math.max(
          Math.abs(left - expectedDerivative),
          Math.abs(right - expectedDerivative),
        );
        expect(error).toBeLessThan(0.000003);
        expect(error).toBeLessThan(previousError);
        previousError = error;
      }
    }
    const input: WorkerInput = {
      zones: backings,
      arenaFloorIds: noFloors,
      arenaGradeHeight: null,
      queries: Array.from({ length: 21 }, (_, i) => ({
        x: 376 + i * 0.1,
        z: 401,
        proceduralHeight: 25,
      })),
    };
    const receipt = await runWorker(
      createAuthoredTerrainSurfaceOperations.toString(),
      input,
    );
    expect(receipt).toEqual(expectedWorker(input));
    for (const [x, z] of [
      [350, 406],
      [361, 419],
      [385, 376],
      [395, 385],
    ])
      expect(sample(x, z)).toBe(datum);
    for (const [x, z] of [
      [400, 450],
      [300, 320],
    ])
      expect(
        operations.resolveHeight(backings, x, z, () => 25, noFloors, null),
      ).toBeNull();
  });

  it("joins unchanged same-height legacy grades continuously without reinterpreting their distant overlaps", () => {
    const legacy = zone({ width: 40, depth: 40, blendRadius: 20 });
    const union = zone({
      id: "candidate",
      centerX: 370,
      blendRadius: 10,
      blendShape: "rounded",
      blendComposition: "smooth-union",
    });
    const sample = (x: number, zones = [legacy, union]) =>
      operations.resolveHeight(zones, x, 320, rawHeight, noFloors, null)!;
    const e = 1e-4;
    for (const x of [380, 385]) {
      const left = (sample(x) - sample(x - e)) / e;
      const right = (sample(x + e) - sample(x)) / e;
      expect(Math.abs(left - right)).toBeLessThan(0.0003);
    }
    expect(sample(380)).toBe(30); // Two outside weights of one half.
    expect(sample(385)).toBe(sample(385, [legacy]));
    const delta = (x: number) => sample(x) - sample(x, [legacy]);
    expect(Math.abs(delta(385 - e) / e)).toBeLessThan(0.0002);
    expect(delta(385 + e)).toBe(0);
    const unmarked = [
      legacy,
      zone({
        id: "second-legacy",
        centerX: 365,
        width: 30,
        depth: 30,
        blendRadius: 20,
      }),
    ];
    const distantUnion = { ...union, centerX: 600 };
    for (let x = 290; x <= 430; x += 0.5)
      for (let z = 280; z <= 365; z += 0.5)
        expect(
          operations.resolveHeight(
            [...unmarked, distantUnion],
            x,
            z,
            rawHeight,
            noFloors,
            null,
          ),
        ).toBe(
          operations.resolveHeight(unmarked, x, z, rawHeight, noFloors, null),
        );
  });

  it("does not merge different target heights or alter prior core selection", () => {
    const legacy = zone({ blendRadius: 20 });
    const union = zone({
      id: "different-datum",
      height: 22,
      blendRadius: 10,
      blendShape: "rounded",
      blendComposition: "smooth-union",
    });
    expect(height([legacy, union], 10)).toBe(height([legacy], 10));
    expect(height([legacy, union])).toBe(20);
    expect(height([union, legacy])).toBe(22);
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

  it("preserves legacy radial samples exactly when bank sectors are omitted or empty", () => {
    const original = pond();
    const empty = {
      ...original,
      radialPond: { ...original.radialPond!, bankSectors: [] },
    };
    for (let step = 0; step < 72; step++) {
      const angle = (step * Math.PI) / 36;
      for (let radialStep = 0; radialStep <= 115; radialStep++) {
        const radius = radialStep / 10;
        const x = original.centerX + Math.cos(angle) * radius;
        const z = original.centerZ + Math.sin(angle) * radius;
        expect(
          operations.resolveRadialPondTerrainHeight(empty, x, z, rawHeight),
        ).toBe(
          operations.resolveRadialPondTerrainHeight(original, x, z, rawHeight),
        );
      }
    }
  });

  it("uses actual sector heights and convex overlap rather than a color-only pond ring", () => {
    const candidate = asymmetricPondCandidate();
    const profile = candidate.radialPond!;
    const unwarped = {
      ...candidate,
      radialPond: { ...profile, shorelineAmplitude: 0 },
    };
    const sample = (zone: AuthoredTerrainZone, angle: number, radius: number) =>
      operations.resolveRadialPondTerrainHeight(
        zone,
        zone.centerX + Math.cos(angle) * radius,
        zone.centerZ + Math.sin(angle) * radius,
        rawHeight,
      );
    for (const sector of profile.bankSectors!) {
      expect(sample(unwarped, sector.bearing, profile.bedRadius)).toBeCloseTo(
        candidate.height,
        12,
      );
      expect(sample(unwarped, sector.bearing, sector.innerRadius)).toBeCloseTo(
        sector.innerHeight,
        12,
      );
      // Independently known smoothstep(0.5)=0.5 in each physical span.
      expect(
        sample(
          unwarped,
          sector.bearing,
          (profile.bedRadius + sector.innerRadius) / 2,
        ),
      ).toBeCloseTo((candidate.height + sector.innerHeight) / 2, 12);
      expect(
        sample(
          unwarped,
          sector.bearing,
          (sector.innerRadius + profile.bankOuterRadius) / 2,
        ),
      ).toBeCloseTo((sector.innerHeight + profile.bankHeight) / 2, 12);
    }
    const shelf = profile.bankSectors![0];
    const overlapping = {
      ...unwarped,
      radialPond: {
        ...unwarped.radialPond,
        bankSectors: [shelf, { ...shelf, innerHeight: profile.bankHeight }],
      },
    };
    expect(sample(overlapping, shelf.bearing, shelf.innerRadius)).toBeCloseTo(
      (shelf.innerHeight + profile.bankHeight) / 2,
      12,
    );
  });

  it("keeps the candidate bed, fishing approach and outer envelope while making unequal monotonic contacts", () => {
    const candidate = asymmetricPondCandidate();
    const profile = candidate.radialPond!;
    const original = {
      ...candidate,
      radialPond: { ...profile, bankSectors: undefined },
    };
    const water = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    expect(water.radius).toBe(7.5);
    const sample = (zone: AuthoredTerrainZone, angle: number, radius: number) =>
      operations.resolveRadialPondTerrainHeight(
        zone,
        zone.centerX + Math.cos(angle) * radius,
        zone.centerZ + Math.sin(angle) * radius,
        rawHeight,
      );
    const crossing = (angle: number, target: number) => {
      let low = 0;
      let high = profile.bankOuterRadius;
      expect(sample(candidate, angle, low)).toBeLessThan(target);
      expect(sample(candidate, angle, high)).toBeGreaterThan(target);
      for (let step = 0; step < 40; step++) {
        const radius = (low + high) / 2;
        if (sample(candidate, angle, radius)! < target) low = radius;
        else high = radius;
      }
      return (low + high) / 2;
    };
    const angles = [
      ...Array.from({ length: 144 }, (_, step) => (step * Math.PI) / 72),
      ...profile.bankSectors!.flatMap((sector) => [
        sector.bearing,
        sector.bearing - sector.halfWidth,
        sector.bearing + sector.halfWidth,
      ]),
    ];
    for (const angle of angles) {
      let previous = candidate.height;
      for (let radialStep = 0; radialStep <= 180; radialStep++) {
        const radius = radialStep / 20;
        const actual = sample(candidate, angle, radius)!;
        expect(Number.isFinite(actual)).toBe(true);
        expect(actual).toBeGreaterThanOrEqual(previous - 1e-12);
        expect(actual).toBeGreaterThanOrEqual(candidate.height);
        expect(actual).toBeLessThanOrEqual(profile.bankHeight + 1e-12);
        if (
          radius <= profile.bedRadius - profile.shorelineAmplitude! ||
          Math.sin(angle) >= 0
        )
          expect(actual).toBe(sample(original, angle, radius));
        previous = actual;
      }
      for (const radius of [9, 9.000001, 9.5, 10, 10.999999, 11, 12])
        expect(sample(candidate, angle, radius)).toBe(
          sample(original, angle, radius),
        );
      const shore = crossing(angle, water.surfaceY);
      expect(shore).toBeLessThan(water.radius);
      expect(sample(candidate, angle, shore - 0.001)).toBeLessThan(
        water.surfaceY,
      );
      expect(sample(candidate, angle, shore + 0.001)).toBeGreaterThan(
        water.surfaceY,
      );
    }
    const contactWidths = profile.bankSectors!.map(
      (sector) =>
        crossing(sector.bearing, water.surfaceY + 0.22) -
        crossing(sector.bearing, water.surfaceY + 0.04),
    );
    // Physical proof of materially unequal contacts, not a screenshot verdict.
    expect(contactWidths[0]).toBeGreaterThan(2 * contactWidths[1]);
    expect(
      sample(candidate, profile.bankSectors![0].bearing, 7.5),
    ).toBeLessThan(
      sample(original, profile.bankSectors![0].bearing, 7.5)! - 0.05,
    );
  });

  it("keeps sector joins continuous and the candidate portable to the actual surface worker", async () => {
    const candidate = asymmetricPondCandidate();
    const profile = candidate.radialPond!;
    const queries: SurfaceQuery[] = [];
    for (const sector of profile.bankSectors!)
      for (const angle of [
        sector.bearing - sector.halfWidth,
        sector.bearing,
        sector.bearing + sector.halfWidth,
      ])
        for (const radius of [4, 5, 6.25, 6.55, 7, 8, 9, 10, 11]) {
          const values = [-1e-7, 0, 1e-7].map((epsilon) => {
            const query = {
              x: candidate.centerX + Math.cos(angle + epsilon) * radius,
              z: candidate.centerZ + Math.sin(angle + epsilon) * radius,
              proceduralHeight: 60,
            };
            queries.push(query);
            return operations.resolveHeight(
              [candidate],
              query.x,
              query.z,
              rawHeight,
              noFloors,
              null,
            );
          });
          if (values.every((value) => value !== null))
            expect(
              Math.max(...(values as number[])) -
                Math.min(...(values as number[])),
            ).toBeLessThan(1e-5);
        }
    const input: WorkerInput = {
      zones: [candidate],
      arenaFloorIds: noFloors,
      arenaGradeHeight: null,
      queries,
    };
    expect(
      await runWorker(createAuthoredTerrainSurfaceOperations.toString(), input),
    ).toEqual(expectedWorker(input));
  });

  it("keeps review49's three-sector pond monotonic and covered by the unchanged water disk across bearings", () => {
    const original = asymmetricPondCandidate();
    const candidate = review49PondCandidate();
    const profile = candidate.radialPond!;
    const sector = profile.bankSectors![2];
    const water = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    expect([candidate.centerX, candidate.centerZ]).toEqual([343, 302]);
    expect([
      water.centerX,
      water.centerZ,
      water.surfaceY,
      water.radius,
    ]).toEqual([343, 302, 27.8, 7.5]);
    expect(profile.shorelineAmplitude).toBe(0.9);
    expect(profile.bankSectors!.slice(0, 2)).toEqual(
      original.radialPond!.bankSectors,
    );
    expect(original.radialPond!.bankSectors).toHaveLength(2);
    expect(profile.bankSectors).toHaveLength(3);
    const sample = (zone: AuthoredTerrainZone, angle: number, radius: number) =>
      operations.resolveRadialPondTerrainHeight(
        zone,
        zone.centerX + Math.cos(angle) * radius,
        zone.centerZ + Math.sin(angle) * radius,
        rawHeight,
      );
    // A full one-degree sweep plus every sector center/join (on both sides),
    // not just the modified ray. This is bounded numeric coverage, not a
    // rendered-water or continuous analytic proof between sampled bearings.
    const angles = [
      ...Array.from({ length: 360 }, (_, step) => (step * Math.PI) / 180),
      ...profile.bankSectors!.flatMap((contact) =>
        [
          contact.bearing - contact.halfWidth,
          contact.bearing,
          contact.bearing + contact.halfWidth,
        ].flatMap((angle) => [-1e-7, 0, 1e-7].map((delta) => angle + delta)),
      ),
    ];
    for (const angle of angles) {
      let previous = candidate.height;
      const distance = Math.abs(
        Math.atan2(
          Math.sin(angle - sector.bearing),
          Math.cos(angle - sector.bearing),
        ),
      );
      for (let step = 0; step <= 180; step++) {
        const radius = step / 20;
        const actual = sample(candidate, angle, radius)!;
        expect(Number.isFinite(actual)).toBe(true);
        expect(actual).toBeGreaterThanOrEqual(previous - 1e-12);
        expect(actual).toBeGreaterThanOrEqual(candidate.height);
        expect(actual).toBeLessThanOrEqual(profile.bankHeight + 1e-12);
        if (
          radius <= profile.bedRadius - profile.shorelineAmplitude! ||
          distance > sector.halfWidth + 1e-12
        )
          expect(actual).toBe(sample(original, angle, radius));
        previous = actual;
      }
      // Preserve the exact outer grade, blend and null boundary. The new
      // shoulder is not permitted to move the world/station support envelope.
      for (const radius of [9, 9.000001, 9.5, 10, 10.999999, 11, 12])
        expect(sample(candidate, angle, radius)).toBe(
          sample(original, angle, radius),
        );
      let low = 0;
      let high = profile.bankOuterRadius;
      for (let step = 0; step < 40; step++) {
        const radius = (low + high) / 2;
        if (sample(candidate, angle, radius)! < water.surfaceY) low = radius;
        else high = radius;
      }
      const shore = (low + high) / 2;
      expect(shore).toBeLessThan(water.radius);
      expect(sample(candidate, angle, shore - 0.001)).toBeLessThan(
        water.surfaceY,
      );
      expect(sample(candidate, angle, shore + 0.001)).toBeGreaterThan(
        water.surfaceY,
      );
      expect(sample(candidate, angle, water.radius)).toBeGreaterThan(
        water.surfaceY,
      );
    }
  });

  it("quantifies review49's wider above-water shoulder against the unchanged preview44 bearing", () => {
    const original = asymmetricPondCandidate();
    const candidate = review49PondCandidate();
    const profile = candidate.radialPond!;
    const bearing = profile.bankSectors![2].bearing;
    const waterY = ALL_WORLD_AREAS.haven_pond.waterBodies![0].surfaceY;
    const crossing = (zone: AuthoredTerrainZone, target: number) => {
      let low = 0;
      let high = profile.bankOuterRadius;
      for (let step = 0; step < 40; step++) {
        const radius = (low + high) / 2;
        const actual = operations.resolveRadialPondTerrainHeight(
          zone,
          zone.centerX + Math.cos(bearing) * radius,
          zone.centerZ + Math.sin(bearing) * radius,
          rawHeight,
        )!;
        if (actual < target) low = radius;
        else high = radius;
      }
      return (low + high) / 2;
    };
    // Same physical +4cm to +22cm band used by the earlier contact test,
    // including the actual 0.9m shoreline warp rather than an unwarped proxy.
    const oldStart = crossing(original, waterY + 0.04);
    const oldEnd = crossing(original, waterY + 0.22);
    const newStart = crossing(candidate, waterY + 0.04);
    const newEnd = crossing(candidate, waterY + 0.22);
    const oldWidth = oldEnd - oldStart;
    const newWidth = newEnd - newStart;
    expect(oldWidth).toBeGreaterThan(0.2);
    expect(oldWidth).toBeLessThan(0.3);
    expect(newWidth).toBeGreaterThan(1.3);
    expect(newWidth).toBeLessThan(1.6);
    expect(newWidth).toBeGreaterThan(4 * oldWidth);
    expect(newStart).toBeLessThan(oldStart);
    expect(newEnd).toBeGreaterThan(oldEnd);
  });

  it("keeps review49's third-sector joins and exact heights portable to the actual surface worker", async () => {
    const candidate = review49PondCandidate();
    const sector = candidate.radialPond!.bankSectors![2];
    const queries: SurfaceQuery[] = [];
    const sample = (angle: number, radius: number) => {
      const query = {
        x: candidate.centerX + Math.cos(angle) * radius,
        z: candidate.centerZ + Math.sin(angle) * radius,
        proceduralHeight: 60,
      };
      queries.push(query);
      return operations.resolveHeight(
        [candidate],
        query.x,
        query.z,
        rawHeight,
        noFloors,
        null,
      );
    };
    for (let step = 0; step < 72; step++)
      for (const radius of [0, 4.1, 5, 6.4, 7, 7.25, 7.5, 8, 9, 10, 11])
        sample((step * Math.PI) / 36, radius);
    for (const angle of [
      sector.bearing - sector.halfWidth,
      sector.bearing,
      sector.bearing + sector.halfWidth,
    ])
      for (const radius of [4.1, 5, 6.4, 7, 7.25, 7.5, 8, 9, 10, 11]) {
        const values = [-1e-7, 0, 1e-7].map((delta) =>
          sample(angle + delta, radius),
        );
        if (values.every((value) => value !== null))
          expect(
            Math.max(...(values as number[])) -
              Math.min(...(values as number[])),
          ).toBeLessThan(1e-5);
      }
    const input: WorkerInput = {
      zones: [candidate],
      arenaFloorIds: noFloors,
      arenaGradeHeight: null,
      queries,
    };
    expect(
      await runWorker(createAuthoredTerrainSurfaceOperations.toString(), input),
    ).toEqual(expectedWorker(input));
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

  it("strictly admits paired outer knots without changing four-field admission", () => {
    const original = review49PondCandidate();
    const candidate = review52PondCandidate();
    expect(validateRadialPondTerrainProfile(original)).toBeNull();
    expect(validateRadialPondTerrainProfile(candidate)).toBeNull();
    const row = candidate.radialPond!.bankSectors![0];
    const withRow = (value: unknown) =>
      ({
        ...candidate,
        radialPond: { ...candidate.radialPond!, bankSectors: [value] },
      }) as AuthoredTerrainZone;
    expect(
      validateRadialPondTerrainProfile(
        withRow(Object.assign(Object.create(null), row)),
      ),
    ).toBeNull();
    expect(
      validateRadialPondTerrainProfile(
        withRow({
          ...row,
          outerRadius: 10.5,
          outerHeight: candidate.radialPond!.bankHeight + 0.6,
        }),
      ),
    ).toBeNull();
    const { outerRadius, outerHeight, ...legacy } = row;
    const invalidRows: unknown[] = [
      { ...legacy, outerRadius },
      { ...legacy, outerHeight },
      { ...row, outerRadius: undefined, outerHeight: undefined },
      { ...row, outerRadius: NaN },
      { ...row, outerHeight: Infinity },
      { ...row, outerRadius: row.innerRadius },
      { ...row, outerRadius: 11 },
      { ...row, outerHeight: row.innerHeight - 1e-8 },
      { ...row, outerHeight: candidate.radialPond!.bankHeight + 0.600001 },
      { ...row, extra: 0 },
      { ...row, [Symbol("hidden")]: 0 },
      Object.assign(Object.create({ outerRadius, outerHeight }), legacy),
      Object.defineProperty({ ...row }, "outerRadius", { enumerable: false }),
    ];
    let getterCalls = 0;
    invalidRows.push(
      Object.defineProperty({ ...row }, "outerHeight", {
        enumerable: true,
        get() {
          getterCalls++;
          return outerHeight;
        },
      }),
    );
    for (const invalid of invalidRows)
      expect(validateRadialPondTerrainProfile(withRow(invalid))).not.toBeNull();
    expect(getterCalls).toBe(0);
    expect(validateRadialPondTerrainProfile(withRow(legacy))).toBeNull();
    expect(
      validateRadialPondTerrainProfile({
        ...candidate,
        radialPond: {
          ...candidate.radialPond!,
          bankSectors: Array(5).fill(row),
        },
      }),
    ).not.toBeNull();
  });

  it("passes through paired knots and joins the varying underlying owner lazily", () => {
    const candidate = unwarpedPairedPond();
    let calls = 0;
    const underlying = (radius: number) => 27.8 + 0.03 * radius;
    const sample = (radius: number) =>
      operations.resolveRadialPondTerrainHeight(candidate, radius, 0, () => {
        calls++;
        return underlying(radius);
      });
    for (const [radius, expected] of [
      [0, 26.6],
      [5, 26.6],
      [5.5, (26.6 + 27.98) / 2],
      [6, 27.98],
      [7.1, (27.98 + 28.55) / 2],
      [8.2, 28.55],
    ])
      expect(sample(radius)).toBeCloseTo(expected, 12);
    expect(calls).toBe(0);
    expect(sample(9.6)).toBeCloseTo((28.55 + underlying(9.6)) / 2, 12);
    expect(calls).toBe(1);
    // A knot-sampled constant would give a different result on this plane.
    expect(sample(9.6)).not.toBeCloseTo((28.55 + underlying(8.2)) / 2, 8);
    expect(sample(11)).toBeNull();
    expect(sample(12)).toBeNull();
    expect(calls).toBe(2);
    const finalHeight = (radius: number) =>
      sample(radius) ?? underlying(radius);
    for (const [radius, expectedDerivative] of [
      [5, 0],
      [6, 0],
      [8.2, 0],
      [11, 0.03],
    ]) {
      let previousError = Infinity;
      for (const epsilon of [1e-4, 1e-5]) {
        const center = finalHeight(radius);
        const left = (center - finalHeight(radius - epsilon)) / epsilon;
        const right = (finalHeight(radius + epsilon) - center) / epsilon;
        const error = Math.max(
          Math.abs(left - expectedDerivative),
          Math.abs(right - expectedDerivative),
        );
        expect(error).toBeLessThan(0.001);
        expect(error).toBeLessThan(previousError);
        previousError = error;
      }
    }
  });

  it("convexly combines paired and historical sectors across the old outer bank", () => {
    const candidate = unwarpedPairedPond();
    const paired = candidate.radialPond!.bankSectors![0];
    const { outerRadius: _radius, outerHeight: _height, ...legacy } = paired;
    const mixed = {
      ...candidate,
      radialPond: { ...candidate.radialPond!, bankSectors: [paired, legacy] },
    };
    const smooth = (t: number) => t * t * (3 - 2 * t);
    const radius = 9.6;
    const expectedPaired = (28.55 + 29) / 2;
    const expectedLegacy = 28.08 + (29 - 28.08) * smooth((radius - 9) / 2);
    let calls = 0;
    const underlying = () => {
      calls++;
      return 29;
    };
    expect(
      operations.resolveRadialPondTerrainHeight(mixed, radius, 0, underlying),
    ).toBeCloseTo((expectedPaired + expectedLegacy) / 2, 12);
    expect(calls).toBe(1); // Shared real underlying query, not one per sector.
    const reversed = {
      ...mixed,
      radialPond: { ...mixed.radialPond, bankSectors: [legacy, paired] },
    };
    expect(
      operations.resolveRadialPondTerrainHeight(
        reversed,
        radius,
        0,
        underlying,
      ),
    ).toBe(
      operations.resolveRadialPondTerrainHeight(mixed, radius, 0, underlying),
    );
    const angle = paired.halfWidth / 2; // One sector at exactly half angular weight.
    expect(
      operations.resolveRadialPondTerrainHeight(
        candidate,
        radius * Math.cos(angle),
        radius * Math.sin(angle),
        underlying,
      ),
    ).toBeCloseTo((expectedPaired + expectedLegacy) / 2, 12);
    const lateKnot = {
      ...candidate,
      radialPond: {
        ...candidate.radialPond!,
        bankSectors: [{ ...paired, outerRadius: 10 }],
      },
    };
    calls = 0;
    expect(
      operations.resolveRadialPondTerrainHeight(lateKnot, 9.5, 0, underlying),
    ).toBeGreaterThan(28);
    expect(calls).toBe(0); // Full coverage needs no unused legacy outer blend.
  });

  it("preserves southern heights, old exterior and callback counts outside paired support exactly", () => {
    const original = review49PondCandidate();
    const candidate = review52PondCandidate();
    for (let bearing = 0; bearing <= 90; bearing++) {
      const angle = (bearing * Math.PI) / 90;
      for (let step = 0; step <= 48; step++) {
        const radius = step / 4;
        const x = candidate.centerX + radius * Math.cos(angle);
        const z = candidate.centerZ + radius * Math.sin(angle);
        let oldCalls = 0,
          newCalls = 0;
        const oldHeight = operations.resolveRadialPondTerrainHeight(
          original,
          x,
          z,
          () => {
            oldCalls++;
            return 28.3 + x * 0.01 - z * 0.02;
          },
        );
        const newHeight = operations.resolveRadialPondTerrainHeight(
          candidate,
          x,
          z,
          () => {
            newCalls++;
            return 28.3 + x * 0.01 - z * 0.02;
          },
        );
        expect(newHeight).toBe(oldHeight);
        expect(newCalls).toBe(oldCalls);
      }
    }
  });

  it("keeps the proposed landform finite, bounded and covered without assuming a monotonic outer shoulder", async () => {
    const candidate = review52PondCandidate();
    const original = review49PondCandidate();
    const water = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    const queries: SurfaceQuery[] = [];
    let minimumDiskClearance = Infinity;
    let maximumRaisedDifference = -Infinity;
    let descents = 0;
    for (let bearing = 0; bearing < 360; bearing++) {
      const angle = (bearing * Math.PI) / 180;
      let reachedDry = false;
      let previous = candidate.height;
      for (let step = 0; step <= 220; step++) {
        const radius = step / 20;
        const x = candidate.centerX + radius * Math.cos(angle);
        const z = candidate.centerZ + radius * Math.sin(angle);
        const value =
          operations.resolveRadialPondTerrainHeight(
            candidate,
            x,
            z,
            () => 28.3,
          ) ?? 28.3;
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(candidate.height - 1e-12);
        expect(value).toBeLessThanOrEqual(28.55 + 1e-12);
        if (reachedDry) expect(value).toBeGreaterThanOrEqual(water.surfaceY);
        if (value >= water.surfaceY) reachedDry = true;
        if (value < previous - 1e-6) descents++;
        previous = value;
        if (radius === water.radius)
          minimumDiskClearance = Math.min(
            minimumDiskClearance,
            value - water.surfaceY,
          );
        if (radius >= 7 && radius < 11) {
          const prior = operations.resolveRadialPondTerrainHeight(
            original,
            x,
            z,
            () => 28.3,
          )!;
          maximumRaisedDifference = Math.max(
            maximumRaisedDifference,
            value - prior,
          );
        }
        if (bearing % 15 === 0 && step % 10 === 0)
          queries.push({ x, z, proceduralHeight: 28.3 });
      }
    }
    expect(minimumDiskClearance).toBeGreaterThan(0.05);
    expect(maximumRaisedDifference).toBeGreaterThan(0.4);
    expect(descents).toBeGreaterThan(0);
    const input: WorkerInput = {
      zones: [candidate],
      arenaFloorIds: noFloors,
      arenaGradeHeight: null,
      queries,
    };
    expect(
      await runWorker(createAuthoredTerrainSurfaceOperations.toString(), input),
    ).toEqual(expectedWorker(input));
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

  it("uses inclusive grass-only bounds without changing grading, normal stencils or overlapping pads", async () => {
    const original = zone();
    const bounded = zone({
      grassExclusionBounds: { minX: 349, maxX: 352, minZ: 318, maxZ: 321 },
    });
    const queries = [
      [349, 318],
      [349, 321],
      [352, 318],
      [352, 321],
      [349, 320],
      [352, 320],
      [350, 318],
      [350, 321],
      [350, 320],
      [349 - 1e-8, 320],
      [352 + 1e-8, 320],
      [350, 318 - 1e-8],
      [350, 321 + 1e-8],
      [356, 326],
      [357, 327],
    ];
    const expected = queries.map((_, index) => index < 9);
    expect(
      queries.map(([x, z]) => operations.isGrassExcluded([bounded], x, z)),
    ).toEqual(expected);
    expect(
      queries.map(([x, z]) => operations.isGrassExcluded([original], x, z)),
    ).toEqual(queries.map(() => true));
    for (const dx of [-7.00001, -7, -6, -5, -1, 0, 2, 5, 6, 7, 7.00001])
      for (const dz of [-7, -6, -5, 0, 5, 6, 7])
        for (const [sx, sz] of [
          [0, 0],
          [-0.5, 0],
          [0.5, 0],
          [0, -0.5],
          [0, 0.5],
        ])
          expect(height([bounded], dx + sx, dz + sz)).toBe(
            height([original], dx + sx, dz + sz),
          );
    const pad = zone({
      id: "independent-pad",
      centerX: 356,
      width: 1,
      depth: 1,
      blendRadius: 0,
    });
    for (const zones of [
      [bounded, pad],
      [pad, bounded],
    ])
      expect(operations.isGrassExcluded(zones, 356, 320)).toBe(true);
    const input: WorkerInput = {
      zones: [bounded],
      arenaFloorIds: noFloors,
      arenaGradeHeight: null,
      queries: queries.map(([x, z]) => ({ x, z, proceduralHeight: 60 })),
    };
    const actual = await runWorker(
      createAuthoredTerrainSurfaceOperations.toString(),
      input,
    );
    expect(actual.map((value) => value.excluded)).toEqual(expected);
    expect(actual.map((value) => value.height)).toEqual(
      queries.map(([x, z]) => height([original], x - 350, z - 320)),
    );
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
    const candidate = review52PondCandidate();
    const pairedInput: WorkerInput = {
      zones: [candidate],
      arenaFloorIds: noFloors,
      arenaGradeHeight: null,
      queries: candidate.radialPond!.bankSectors!.flatMap((sector) =>
        [5.5, 6.4, 7.5, 8.2, 8.7, 9, 9.5, 10.5, 11].map((radius) => ({
          x: candidate.centerX + Math.cos(sector.bearing) * radius,
          z: candidate.centerZ + Math.sin(sector.bearing) * radius,
          proceduralHeight: 28.3 + radius * 0.03,
        })),
      ),
    };
    expect(await runWorker(factorySource, pairedInput)).toEqual(
      expectedWorker(pairedInput),
    );
  });
});
