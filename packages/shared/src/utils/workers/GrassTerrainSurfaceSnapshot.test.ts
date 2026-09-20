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
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../../systems/shared/world/WorldTerrainProfile";
import {
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  createGrassTerrainSurfaceOperations,
  createGrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceZone,
  type GrassTerrainWaterBody,
  type GrassTerrainExclusionPolygon,
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

function sectorPond(): GrassTerrainSurfaceZone {
  return zone({
    id: "sector-pond",
    width: 22,
    depth: 22,
    height: 26.6,
    blendRadius: 2,
    radialPond: {
      bedRadius: 5,
      bankInnerRadius: 7,
      bankOuterRadius: 9,
      bankHeight: 28.08,
      shorelineAmplitude: 0.9,
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
  });
}

function pairedSectorPond(): GrassTerrainSurfaceZone {
  const pond = sectorPond();
  pond.id = "paired-sector-pond";
  Object.assign(pond.radialPond!.bankSectors![0], {
    innerRadius: 6,
    innerHeight: 27.98,
    outerRadius: 8.2,
    outerHeight: 28.55,
  });
  return pond;
}

function compositionPond(): GrassTerrainSurfaceZone {
  const pond = pairedSectorPond();
  pond.radialPond!.bankComposition = {
    schemaVersion: 1,
    sectors: [
      { sectorIndex: 0, surface: "sedge-shelf" },
      { sectorIndex: 1, surface: "cutbank" },
    ],
  };
  return pond;
}

type WorkerReceipt = {
  error?: string;
  snapshot: GrassTerrainSurfaceSnapshot;
  water: number[];
  candidateIds: string[][];
  indexedZoneReferences: number;
  excluded: boolean[];
  boxes?: { boundsOverlap: boolean; phases: string[]; intersects: boolean }[];
  compositionFrozen?: boolean;
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
        const snapshot = input.clone ? operations.cloneSnapshot(input.snapshot) : operations.validateSnapshot(input.snapshot);
        const index = operations.createZoneIndex(snapshot, input.tileSize ?? 100);
        const points = input.points ?? [];
        const boxes = input.boxes?.map(box => {
          const polygon = snapshot.exclusionPolygons[0];
          const steps = operations.intersectsExclusionSteps(polygon, box);
          const phases = []; let step = steps.next();
          while (!step.done) { phases.push(step.value); step = steps.next(); }
          return { boundsOverlap: operations.exclusionBoundsOverlap(polygon, box), phases, intersects: step.value };
        });
        parentPort.postMessage({ snapshot, indexedZoneReferences: index.indexedZoneReferences,
          ...(input.clone ? { compositionFrozen: snapshot.zones.every(zone => !zone.radialPond?.bankComposition || (Object.isFrozen(zone.radialPond.bankComposition) && Object.isFrozen(zone.radialPond.bankComposition.sectors) && zone.radialPond.bankComposition.sectors.every(Object.isFrozen))) } : {}),
          ...(boxes ? { boxes } : {}),
          excluded: points.map(p => operations.isGrassExcluded(snapshot, p[0], p[1])),
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
  it("round-trips mineral-shore through actual worker admission without vegetation metadata", async () => {
    const source = compositionPond();
    Object.assign(source.radialPond!.bankComposition!.sectors[0], {
      surface: "mineral-shore",
    });
    const cloned = operations.cloneSnapshot(snapshot([source]));
    expect(cloned.zones[0].radialPond!.bankComposition!.sectors[0]).toEqual({
      sectorIndex: 0,
      surface: "mineral-shore",
    });
    expect(
      Object.isFrozen(cloned.zones[0].radialPond!.bankComposition!.sectors[0]),
    ).toBe(true);
    const worker = actualWorker();
    try {
      const result = await worker.execute({
        snapshot: snapshot([source]),
        clone: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.snapshot).toEqual(cloned);
      expect(result.compositionFrozen).toBe(true);
      Object.assign(source.radialPond!.bankComposition!.sectors[0], {
        groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
      });
      expect(validateRadialPondTerrainProfile(source)).toMatch(
        /mineral-shore.*groundCover/,
      );
      expect(() => operations.cloneSnapshot(snapshot([source]))).toThrow(
        /mineral-shore.*groundCover/,
      );
      expect(
        (await worker.execute({ snapshot: snapshot([source]), clone: true }))
          .error,
      ).toMatch(/mineral-shore.*groundCover/);
    } finally {
      await worker.close();
    }
  });
  it("strictly admits, detaches and freezes optional emergence metadata on host and the real worker", async () => {
    const source = compositionPond();
    Object.assign(source.radialPond!.bankComposition!.sectors[0], {
      groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
    });
    expect(validateRadialPondTerrainProfile(source)).toBeNull();
    const clone = operations.cloneSnapshot(snapshot([source]));
    const cover =
      clone.zones[0].radialPond!.bankComposition!.sectors[0].groundCover!;
    expect(cover).toEqual({ emergenceHeight: 0.04, fullHeight: 0.12 });
    expect(cover).not.toBe(
      source.radialPond!.bankComposition!.sectors[0].groundCover,
    );
    expect(Object.isFrozen(cover)).toBe(true);
    expect(
      clone.zones[0].radialPond!.bankComposition!.sectors[1],
    ).not.toHaveProperty("groundCover");
    const worker = actualWorker();
    try {
      const receipt = await worker.execute({
        snapshot: snapshot([source]),
        clone: true,
      });
      expect(receipt.error).toBeUndefined();
      expect(receipt.snapshot).toEqual(clone);
      for (const groundCover of [
        undefined,
        null,
        [],
        {},
        { emergenceHeight: 0, fullHeight: 0.12 },
        { emergenceHeight: -0.01, fullHeight: 0.12 },
        { emergenceHeight: 0.12, fullHeight: 0.12 },
        { emergenceHeight: 0.13, fullHeight: 0.12 },
        { emergenceHeight: 0.1, fullHeight: 0.10000000001 },
        { emergenceHeight: 0.04, fullHeight: 0.601 },
        { emergenceHeight: NaN, fullHeight: 0.12 },
        { emergenceHeight: 0.04, fullHeight: Infinity },
        { emergenceHeight: 0.04, fullHeight: 0.12, extra: 1 },
      ]) {
        const invalid = compositionPond();
        Object.assign(invalid.radialPond!.bankComposition!.sectors[0], {
          groundCover,
        });
        expect(validateRadialPondTerrainProfile(invalid)).toMatch(
          /groundCover/,
        );
        expect(() => operations.cloneSnapshot(snapshot([invalid]))).toThrow(
          /groundCover/,
        );
        expect(
          (await worker.execute({ snapshot: snapshot([invalid]) })).error,
        ).toMatch(/groundCover/);
      }
      for (const cover of [
        Object.create({ emergenceHeight: 0.04, fullHeight: 0.12 }),
        Object.defineProperty({ fullHeight: 0.12 }, "emergenceHeight", {
          enumerable: true,
          get() {
            throw new Error("must not execute");
          },
        }),
        { emergenceHeight: 0.04, fullHeight: 0.12, [Symbol("hidden")]: true },
      ]) {
        const invalid = compositionPond();
        Object.assign(invalid.radialPond!.bankComposition!.sectors[0], {
          groundCover: cover,
        });
        expect(validateRadialPondTerrainProfile(invalid)).toMatch(
          /groundCover/,
        );
        expect(() => operations.cloneSnapshot(snapshot([invalid]))).toThrow(
          /groundCover/,
        );
      }
    } finally {
      await worker.close();
    }
  });
  it("detaches and freezes optional bank composition while preserving absence and real worker admission", async () => {
    const source = compositionPond();
    expect(validateRadialPondTerrainProfile(source)).toBeNull();
    const expected = structuredClone(snapshot([source]));
    const clone = operations.cloneSnapshot(snapshot([source]));
    const composition = clone.zones[0].radialPond!.bankComposition!;
    expect(clone).toEqual(expected);
    expect(composition).not.toBe(source.radialPond!.bankComposition);
    expect(composition.sectors).not.toBe(
      source.radialPond!.bankComposition!.sectors,
    );
    expect(composition.sectors[0]).not.toBe(
      source.radialPond!.bankComposition!.sectors[0],
    );
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.sectors)).toBe(true);
    expect(composition.sectors.every(Object.isFrozen)).toBe(true);
    Object.assign(source.radialPond!.bankComposition!.sectors[0], {
      surface: "dry-turf",
    });
    expect(clone).toEqual(expected);
    expect(
      operations.cloneSnapshot(snapshot([pairedSectorPond()])).zones[0]
        .radialPond,
    ).not.toHaveProperty("bankComposition");
    const empty = sectorPond();
    delete empty.radialPond!.bankSectors;
    empty.radialPond!.bankComposition = { schemaVersion: 1, sectors: [] };
    expect(validateRadialPondTerrainProfile(empty)).toBeNull();
    expect(operations.cloneSnapshot(snapshot([empty])).zones[0]).toEqual(empty);
    const worker = actualWorker();
    try {
      expect((await worker.execute({ snapshot: clone })).snapshot).toEqual(
        expected,
      );
      expect(
        (await worker.execute({ snapshot: snapshot([empty]) })).snapshot,
      ).toEqual(snapshot([empty]));
      for (const surface of ["sedge-shelf", "cutbank", "dry-turf"] as const) {
        const candidate = compositionPond();
        candidate.radialPond!.bankSectors!.push(
          ...structuredClone(candidate.radialPond!.bankSectors!),
        );
        candidate.radialPond!.bankComposition = {
          schemaVersion: 1,
          sectors: [0, 1, 2, 3].map((sectorIndex) => ({
            sectorIndex,
            surface,
          })),
        };
        expect(validateRadialPondTerrainProfile(candidate)).toBeNull();
        expect(
          (await worker.execute({ snapshot: snapshot([candidate]) })).snapshot,
        ).toEqual(snapshot([candidate]));
      }
    } finally {
      await worker.close();
    }
  });

  it("rejects malformed composition versions, rows and references equally on terrain, snapshot and a real worker", async () => {
    const good = compositionPond().radialPond!.bankComposition!;
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      [],
      { ...good, schemaVersion: 0 },
      { ...good, schemaVersion: "1" },
      { ...good, schemaVersion: NaN },
      { ...good, extra: true },
      { ...good, sectors: undefined },
      { ...good, sectors: null },
      { ...good, sectors: {} },
      { ...good, sectors: Array(1) },
      { ...good, sectors: Array.from({ length: 5 }, () => good.sectors[0]) },
      { ...good, sectors: [good.sectors[0], good.sectors[0]] },
      ...[-1, 2, 0.1, NaN, Infinity, "0", null, undefined].map(
        (sectorIndex) => ({
          ...good,
          sectors: [{ sectorIndex, surface: "cutbank" }],
        }),
      ),
      ...["", "grass", "CUTBANK", null, 1, undefined].map((surface) => ({
        ...good,
        sectors: [{ sectorIndex: 0, surface }],
      })),
      { ...good, sectors: [{ ...good.sectors[0], extra: true }] },
    ];
    const worker = actualWorker();
    try {
      for (const bankComposition of invalid) {
        const candidate = pairedSectorPond();
        Object.defineProperty(candidate.radialPond!, "bankComposition", {
          value: bankComposition,
          enumerable: true,
        });
        expect(validateRadialPondTerrainProfile(candidate)).toMatch(
          /bankComposition/,
        );
        expect(() => operations.cloneSnapshot(snapshot([candidate]))).toThrow(
          /bankComposition/,
        );
        expect(
          (await worker.execute({ snapshot: snapshot([candidate]) })).error,
        ).toMatch(/bankComposition/);
      }
      const missing = compositionPond();
      delete missing.radialPond!.bankSectors;
      expect(validateRadialPondTerrainProfile(missing)).toMatch(
        /bankComposition/,
      );
      expect(
        (await worker.execute({ snapshot: snapshot([missing]) })).error,
      ).toMatch(/bankComposition/);
    } finally {
      await worker.close();
    }
  });

  it("rejects hostile composition descriptors without getters and accepts null-prototype plain data", () => {
    let reads = 0;
    for (const target of [
      "field",
      "version",
      "sectors",
      "entry",
      "index",
      "surface",
    ] as const) {
      for (const kind of [
        "accessor",
        "hidden",
        "inherited",
        "extra",
        "symbol",
      ] as const) {
        const candidate = compositionPond();
        const composition = candidate.radialPond!.bankComposition!;
        const owner =
          target === "field"
            ? candidate.radialPond!
            : target === "version" || target === "sectors"
              ? composition
              : target === "entry"
                ? composition.sectors
                : composition.sectors[0];
        const key =
          target === "field"
            ? "bankComposition"
            : target === "version"
              ? "schemaVersion"
              : target === "sectors"
                ? "sectors"
                : target === "entry"
                  ? "0"
                  : target === "index"
                    ? "sectorIndex"
                    : "surface";
        const value: unknown = Object.getOwnPropertyDescriptor(
          owner,
          key,
        )!.value;
        if (kind === "accessor")
          Object.defineProperty(owner, key, {
            get() {
              reads++;
              return value;
            },
            enumerable: true,
          });
        else if (kind === "hidden")
          Object.defineProperty(owner, key, { value, enumerable: false });
        else if (kind === "inherited") {
          Reflect.deleteProperty(owner, key);
          Object.setPrototypeOf(owner, { [key]: value });
        } else if (target === "field") {
          // Extras belong to the composition record, not the extensible radial profile.
          Object.defineProperty(
            composition,
            kind === "symbol" ? Symbol("extra") : "extra",
            { value: true },
          );
        } else
          Object.defineProperty(
            owner,
            kind === "symbol" ? Symbol("extra") : "extra",
            { value: true },
          );
        expect(validateRadialPondTerrainProfile(candidate)).toMatch(
          /bankComposition/,
        );
        expect(() => operations.cloneSnapshot(snapshot([candidate]))).toThrow(
          /bankComposition/,
        );
      }
    }
    expect(reads).toBe(0);
    const candidate = compositionPond();
    Object.setPrototypeOf(candidate.radialPond!.bankComposition!, null);
    for (const row of candidate.radialPond!.bankComposition!.sectors)
      Object.setPrototypeOf(row, null);
    expect(validateRadialPondTerrainProfile(candidate)).toBeNull();
    expect(operations.cloneSnapshot(snapshot([candidate])).zones[0]).toEqual(
      candidate,
    );
  });

  it("revalidates bank composition after a continuation and atomically copies the newest valid data", () => {
    for (const change of [
      "version",
      "reference",
      "duplicate",
      "getter",
    ] as const) {
      const candidate = compositionPond();
      const steps = operations.cloneSnapshotSteps(snapshot([candidate]));
      let step = steps.next();
      while (!step.done && step.value !== "snapshot_clone_zone")
        step = steps.next();
      expect(step.value).toBe("snapshot_clone_zone");
      const c = candidate.radialPond!.bankComposition!;
      if (change === "version") Object.assign(c, { schemaVersion: 2 });
      else if (change === "reference")
        Object.assign(c.sectors[0], { sectorIndex: 2 });
      else if (change === "duplicate")
        Object.assign(c.sectors[1], { sectorIndex: 0 });
      else
        Object.defineProperty(candidate.radialPond!, "bankComposition", {
          get() {
            throw new Error("Getter must never execute");
          },
          enumerable: true,
        });
      expect(() => steps.next()).toThrow(/bankComposition/);
    }
    const candidate = compositionPond();
    const steps = operations.cloneSnapshotSteps(snapshot([candidate]));
    let step = steps.next();
    while (!step.done && step.value !== "snapshot_clone_zone")
      step = steps.next();
    Object.assign(candidate.radialPond!.bankComposition!.sectors[0], {
      surface: "dry-turf",
    });
    while (!step.done) step = steps.next();
    const detached = step.value.zones[0].radialPond!.bankComposition!;
    expect(detached.sectors[0].surface).toBe("dry-turf");
    expect(Object.isFrozen(detached.sectors[0])).toBe(true);
    Object.assign(candidate.radialPond!.bankComposition!.sectors[0], {
      surface: "cutbank",
    });
    expect(detached.sectors[0].surface).toBe("dry-turf");
  });

  it("preserves paired outer knots and absent legacy fields through detached copies and a real worker", async () => {
    const source = pairedSectorPond();
    expect(validateRadialPondTerrainProfile(source)).toBeNull();
    const expected = structuredClone(snapshot([source]));
    const clone = operations.cloneSnapshot(snapshot([source]));
    const rows = clone.zones[0].radialPond!.bankSectors!;
    expect(clone).toEqual(expected);
    expect(rows[0]).not.toBe(source.radialPond!.bankSectors![0]);
    expect(Reflect.ownKeys(rows[0])).toEqual([
      "bearing",
      "halfWidth",
      "innerRadius",
      "innerHeight",
      "outerRadius",
      "outerHeight",
    ]);
    expect(rows[1]).not.toHaveProperty("outerRadius");
    expect(rows[1]).not.toHaveProperty("outerHeight");
    source.radialPond!.bankSectors![0].outerRadius = 8.7;
    source.radialPond!.bankSectors![0].outerHeight = 28.6;
    expect(clone).toEqual(expected);
    const worker = actualWorker();
    try {
      const result = await worker.execute({
        snapshot: clone,
        points: [[0, 0]],
      });
      expect(result.error).toBeUndefined();
      expect(result.snapshot).toEqual(expected);
      expect(result.candidateIds).toEqual([[source.id]]);
      rows[0].outerHeight = 28.65;
      expect(result.snapshot).toEqual(expected);
    } finally {
      await worker.close();
    }
  });

  it("admits only complete finite bounded outer-knot pairs on terrain, snapshot and real worker", async () => {
    const row = pairedSectorPond().radialPond!.bankSectors![0];
    const legacy = sectorPond().radialPond!.bankSectors![0];
    const invalid: unknown[] = [
      { ...legacy, outerRadius: 8.2 },
      { ...legacy, outerHeight: 28.55 },
      ...[
        { outerRadius: undefined },
        { outerHeight: undefined },
        { outerRadius: null },
        { outerHeight: null },
        { outerRadius: NaN },
        { outerHeight: NaN },
        { outerRadius: Infinity },
        { outerHeight: -Infinity },
        { outerRadius: "8.2" },
        { outerHeight: "28.55" },
        { outerRadius: row.innerRadius },
        { outerRadius: 11 },
        { outerRadius: 11.01 },
        { outerHeight: row.innerHeight - 0.001 },
        { outerHeight: 28.08 + 0.601 },
        { extra: true },
      ].map((change) => ({ ...row, ...change })),
    ];
    const worker = actualWorker();
    try {
      for (const value of invalid) {
        const candidate = sectorPond();
        Object.defineProperty(candidate.radialPond!, "bankSectors", {
          value: [value],
          enumerable: true,
        });
        expect(validateRadialPondTerrainProfile(candidate)).toMatch(
          /bankSectors/,
        );
        const input = snapshot([candidate]);
        expect(() => operations.cloneSnapshot(input)).toThrow(/bankSectors/);
        expect((await worker.execute({ snapshot: input })).error).toMatch(
          /bankSectors/,
        );
      }
      const candidate = pairedSectorPond();
      candidate.radialPond!.bankSectors = [
        { ...row, outerHeight: row.innerHeight },
        { ...row, outerHeight: candidate.radialPond!.bankHeight + 0.6 },
        { ...row, outerRadius: 10.999 },
        legacy,
      ];
      expect(validateRadialPondTerrainProfile(candidate)).toBeNull();
      const clone = operations.cloneSnapshot(snapshot([candidate]));
      expect(clone.zones[0]).toEqual(candidate);
      expect((await worker.execute({ snapshot: clone })).snapshot).toEqual(
        clone,
      );
    } finally {
      await worker.close();
    }
  });

  it("rejects hostile optional-knot descriptors without invoking getters while admitting null-prototype data rows", () => {
    let reads = 0;
    for (const key of ["outerRadius", "outerHeight"] as const) {
      for (const kind of [
        "accessor",
        "inherited",
        "hidden",
        "symbol",
        "extra",
      ] as const) {
        const candidate = pairedSectorPond();
        const row = candidate.radialPond!.bankSectors![0];
        const value = row[key];
        if (kind === "accessor")
          Object.defineProperty(row, key, {
            get() {
              reads++;
              return value;
            },
            enumerable: true,
          });
        else if (kind === "inherited") {
          delete row[key];
          Object.setPrototypeOf(row, { [key]: value });
        } else if (kind === "hidden")
          Object.defineProperty(row, key, { value, enumerable: false });
        else
          Object.defineProperty(
            row,
            kind === "symbol" ? Symbol(key) : "extra",
            {
              value: true,
              enumerable: true,
            },
          );
        expect(validateRadialPondTerrainProfile(candidate)).toMatch(
          /bankSectors/,
        );
        expect(() => operations.cloneSnapshot(snapshot([candidate]))).toThrow(
          /bankSectors/,
        );
      }
    }
    expect(reads).toBe(0);
    const candidate = pairedSectorPond();
    Object.setPrototypeOf(candidate.radialPond!.bankSectors![0], null);
    expect(validateRadialPondTerrainProfile(candidate)).toBeNull();
    expect(operations.cloneSnapshot(snapshot([candidate])).zones[0]).toEqual(
      candidate,
    );
  });

  it("revalidates optional outer knots after the cloning continuation and copies the latest valid pair atomically", () => {
    for (const kind of [
      "radius",
      "height",
      "missing",
      "added-half",
      "blend",
    ] as const) {
      const candidate =
        kind === "added-half" ? sectorPond() : pairedSectorPond();
      const steps = operations.cloneSnapshotSteps(snapshot([candidate]));
      let step = steps.next();
      while (!step.done && step.value !== "snapshot_clone_zone")
        step = steps.next();
      expect(step.value).toBe("snapshot_clone_zone");
      const row = candidate.radialPond!.bankSectors![0];
      if (kind === "radius") row.outerRadius = 11;
      else if (kind === "height") row.outerHeight = NaN;
      else if (kind === "missing") delete row.outerHeight;
      else if (kind === "added-half") row.outerRadius = 8.2;
      else candidate.blendRadius = 0;
      expect(() => steps.next()).toThrow(/bankSectors/);
    }
    const candidate = pairedSectorPond();
    const steps = operations.cloneSnapshotSteps(snapshot([candidate]));
    let step = steps.next();
    while (!step.done && step.value !== "snapshot_clone_zone")
      step = steps.next();
    candidate.radialPond!.bankSectors![0].outerRadius = 8.7;
    candidate.radialPond!.bankSectors![0].outerHeight = 28.6;
    while (!step.done) step = steps.next();
    expect(step.value.zones[0]).toEqual(candidate);
    candidate.radialPond!.bankSectors![0].outerHeight = 28.65;
    expect(step.value.zones[0].radialPond!.bankSectors![0].outerHeight).toBe(
      28.6,
    );
  });

  it("deep-copies bounded pond sectors and preserves them in a real worker without aliasing", async () => {
    const source = sectorPond();
    expect(validateRadialPondTerrainProfile(source)).toBeNull();
    const input = snapshot([source]);
    const before = structuredClone(input);
    const clone = operations.cloneSnapshot(input);
    expect(clone).toEqual(before);
    expect(clone.zones[0].radialPond!.bankSectors).not.toBe(
      source.radialPond!.bankSectors,
    );
    expect(clone.zones[0].radialPond!.bankSectors![0]).not.toBe(
      source.radialPond!.bankSectors![0],
    );
    source.radialPond!.bankSectors![0].innerHeight = 28;
    source.radialPond!.bankSectors!.pop();
    expect(clone).toEqual(before);
    const empty = sectorPond();
    empty.radialPond!.bankSectors = [];
    expect(validateRadialPondTerrainProfile(empty)).toBeNull();
    expect(
      operations.cloneSnapshot(snapshot([empty])).zones[0].radialPond!
        .bankSectors,
    ).toEqual([]);
    delete empty.radialPond!.bankSectors;
    expect(
      operations.cloneSnapshot(snapshot([empty])).zones[0].radialPond,
    ).not.toHaveProperty("bankSectors");
    const worker = actualWorker();
    try {
      const result = await worker.execute({
        snapshot: clone,
        points: [[0, 0]],
      });
      expect(result.error).toBeUndefined();
      expect(result.snapshot).toEqual(before);
      expect(result.candidateIds).toEqual([[source.id]]);
    } finally {
      await worker.close();
    }
  });

  it("rejects invalid pond sector cardinality and bounds identically on terrain, snapshot and real worker", async () => {
    const row = sectorPond().radialPond!.bankSectors![0];
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      Array(1),
      Array.from({ length: 5 }, () => ({ ...row })),
      ...[
        { bearing: NaN },
        { bearing: -Math.PI - 0.01 },
        { bearing: Math.PI + 0.01 },
        { halfWidth: 0 },
        { halfWidth: Math.PI / 2 + 0.01 },
        { halfWidth: Infinity },
        { innerRadius: 5 },
        { innerRadius: 9 },
        { innerHeight: 26.6 },
        { innerHeight: 28.081 },
      ].map((change) => [{ ...row, ...change }]),
      [{ ...row, extra: true }],
      [{ bearing: 0 }],
    ];
    const worker = actualWorker();
    try {
      for (const value of invalid) {
        const candidate = sectorPond();
        Object.defineProperty(candidate.radialPond!, "bankSectors", {
          value,
          enumerable: true,
        });
        expect(validateRadialPondTerrainProfile(candidate)).toMatch(
          /bankSectors/,
        );
        const input = snapshot([candidate]);
        expect(() => operations.cloneSnapshot(input)).toThrow(/bankSectors/);
        expect((await worker.execute({ snapshot: input })).error).toMatch(
          /bankSectors/,
        );
      }
      const extremes = sectorPond();
      extremes.radialPond!.bankSectors = [
        { ...row, bearing: -Math.PI, halfWidth: Math.PI / 2 },
        { ...row, bearing: Math.PI, innerHeight: 28.08 },
      ];
      expect(validateRadialPondTerrainProfile(extremes)).toBeNull();
      expect(operations.cloneSnapshot(snapshot([extremes])).zones[0]).toEqual(
        extremes,
      );
    } finally {
      await worker.close();
    }
  });

  it("rejects inherited or accessor pond sectors without invoking getters and rechecks resumed cloning", () => {
    let reads = 0;
    const value = sectorPond().radialPond!.bankSectors!;
    const candidates = [sectorPond(), sectorPond(), sectorPond(), sectorPond()];
    Object.defineProperty(candidates[0].radialPond!, "bankSectors", {
      get() {
        reads++;
        return value;
      },
      enumerable: true,
    });
    delete candidates[1].radialPond!.bankSectors;
    Object.setPrototypeOf(candidates[1].radialPond!, { bankSectors: value });
    Object.defineProperty(candidates[2].radialPond!.bankSectors!, "0", {
      get() {
        reads++;
        return value[0];
      },
      enumerable: true,
    });
    Object.defineProperty(
      candidates[3].radialPond!.bankSectors![0],
      "innerHeight",
      {
        get() {
          reads++;
          return 27.84;
        },
        enumerable: true,
      },
    );
    for (const candidate of candidates) {
      expect(validateRadialPondTerrainProfile(candidate)).toMatch(
        /bankSectors/,
      );
      expect(() => operations.cloneSnapshot(snapshot([candidate]))).toThrow(
        /bankSectors/,
      );
    }
    expect(reads).toBe(0);
    const mutable = sectorPond();
    const steps = operations.cloneSnapshotSteps(snapshot([mutable]));
    let step = steps.next();
    while (!step.done && step.value !== "snapshot_clone_zone")
      step = steps.next();
    expect(step.value).toBe("snapshot_clone_zone");
    mutable.radialPond!.bankSectors![0].innerHeight = Infinity;
    expect(() => steps.next()).toThrow(/bankSectors/);
  });

  it("owns frozen pond sector rows and invalidates canonical terrain when any nested field changes", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    terrain["activeTerrainProfile"] = validateWorldTerrainProfile({
      ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    await terrain.init();
    try {
      const original = sectorPond();
      terrain.registerFlatZone(original);
      const provider = terrain["buildChunkTerrainProvider"]();
      expect(provider.surfaceRefinementAnnuli).toEqual([
        { centerX: 0, centerZ: 0, innerRadius: 4.1, outerRadius: 7.9 },
      ]);
      const owned = terrain["flatZones"].get(original.id)!;
      expect(Object.isFrozen(owned.radialPond!.bankSectors)).toBe(true);
      expect(owned.radialPond!.bankSectors!.every(Object.isFrozen)).toBe(true);
      const lease = terrain.captureCanonicalGroundLease();
      const sample = lease.sampleHeight(-4, -4);
      original.radialPond!.bankSectors![0].innerHeight = 28;
      terrain.getFlatZoneAt(0, 0)!.radialPond!.bankSectors![0].bearing = 0;
      expect(lease.isCurrent()).toBe(true);
      expect(lease.sampleHeight(-4, -4)).toBe(sample);
      const identical = terrain.getFlatZoneAt(0, 0)!;
      terrain.registerFlatZone(identical);
      expect(lease.isCurrent()).toBe(true);
      for (const [key, value] of [
        ["bearing", -2],
        ["halfWidth", 0.6],
        ["innerRadius", 6.4],
        ["innerHeight", 27.9],
      ] as const) {
        const current = terrain.captureCanonicalGroundLease();
        const updated = terrain.getFlatZoneAt(0, 0)!;
        updated.radialPond!.bankSectors![0][key] = value;
        terrain.registerFlatZone(updated);
        expect(current.isCurrent()).toBe(false);
      }
      const empty = terrain.getFlatZoneAt(0, 0)!;
      empty.radialPond!.bankSectors = [];
      terrain.registerFlatZone(empty);
      expect(provider.surfaceRefinementAnnuli![0].outerRadius).toBe(7.9);
      const absent = terrain.getFlatZoneAt(0, 0)!;
      delete absent.radialPond!.bankSectors;
      terrain.registerFlatZone(absent);
      expect(provider.surfaceRefinementAnnuli![0].outerRadius).toBe(7.9);
    } finally {
      world.destroy();
    }
  });

  it("retains rounded geometry through detached cloning and the real worker index", async () => {
    const rounded = zone({
      blendShape: "rounded",
      blendComposition: "smooth-union",
    });
    const input = snapshot([rounded]);
    const copy = operations.cloneSnapshot(input);
    expect(copy).toEqual(input);
    expect(copy.zones[0]).not.toBe(rounded);
    expect(operations.cloneSnapshot(snapshot()).zones[0]).not.toHaveProperty(
      "blendShape",
    );
    expect(operations.cloneSnapshot(snapshot()).zones[0]).not.toHaveProperty(
      "blendComposition",
    );
    const index = operations.createZoneIndex(copy, 100);
    const oldIndex = operations.createZoneIndex(snapshot(), 100);
    expect(index.indexedZoneReferences).toBe(oldIndex.indexedZoneReferences);
    expect(index.bucketCount).toBe(oldIndex.bucketCount);
    const worker = actualWorker();
    try {
      const result = await worker.execute({
        snapshot: copy,
        points: [
          [14, 10],
          [12.4, 13.2],
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.snapshot.zones[0].blendShape).toBe("rounded");
      expect(result.snapshot.zones[0].blendComposition).toBe("smooth-union");
      expect(result.candidateIds).toEqual([[rounded.id], [rounded.id]]);
    } finally {
      await worker.close();
    }
  });

  it("strictly admits only explicit own smooth-union composition paired with rounded geometry", async () => {
    const invalid = [undefined, null, false, 1, {}, "min", "SMOOTH-UNION"].map(
      (blendComposition) => ({
        ...zone({ blendShape: "rounded" }),
        blendComposition,
      }),
    );
    invalid.push({ ...zone(), blendComposition: "smooth-union" });
    const worker = actualWorker();
    try {
      for (const candidate of invalid) {
        const input = { ...snapshot(), zones: [candidate] };
        expect(() => operations.cloneSnapshot(input)).toThrow(
          /blendComposition/,
        );
        expect((await worker.execute({ snapshot: input })).error).toMatch(
          /blendComposition/,
        );
      }
    } finally {
      await worker.close();
    }
    let reads = 0;
    const getter = {
      enumerable: true,
      get() {
        reads++;
        return "smooth-union";
      },
    };
    const accessor = Object.defineProperty(
      zone({ blendShape: "rounded" }),
      "blendComposition",
      getter,
    );
    const hidden = Object.defineProperty(
      zone({ blendShape: "rounded" }),
      "blendComposition",
      { value: "smooth-union" },
    );
    const inherited = Object.assign(
      Object.create({ blendComposition: "smooth-union" }) as FlatZone,
      zone({ blendShape: "rounded" }),
    );
    for (const candidate of [accessor, hidden, inherited])
      expect(() => operations.cloneSnapshot(snapshot([candidate]))).toThrow(
        /blendComposition/,
      );
    expect(reads).toBe(0);
    const mutable = zone({
      blendShape: "rounded",
      blendComposition: "smooth-union",
    });
    const steps = operations.cloneSnapshotSteps(snapshot([mutable]));
    let step = steps.next();
    while (!step.done && step.value !== "snapshot_clone_zone")
      step = steps.next();
    expect(step.done).toBe(false);
    Object.defineProperty(mutable, "blendComposition", getter);
    expect(() => steps.next()).toThrow(/blendComposition/);
    expect(reads).toBe(0);
  });

  it("rejects malformed or ambiguous rounded metadata before copying, including worker requests", async () => {
    const invalid = [undefined, null, false, 1, {}, "square", "ROUNDED"].map(
      (blendShape) => ({ ...zone(), blendShape }),
    );
    const worker = actualWorker();
    try {
      for (const candidate of [
        ...invalid,
        { ...masked(), blendShape: "rounded" },
        { ...zone({ blendShape: "rounded" }), tileMaskTiles: [] },
        { ...zone({ blendShape: "rounded" }), radialPond: {} },
      ]) {
        const input = { ...snapshot(), zones: [candidate] };
        expect(() => operations.cloneSnapshot(input)).toThrow(/blendShape/);
        expect((await worker.execute({ snapshot: input })).error).toMatch(
          /blendShape/,
        );
      }
      const floor = {
        ...snapshot([zone({ blendShape: "rounded" })]),
        arenaFloorIds: ["grade"],
        arenaGradeHeight: 24,
      };
      expect(() => operations.cloneSnapshot(floor)).toThrow(/arena floors/);
      expect((await worker.execute({ snapshot: floor })).error).toMatch(
        /arena floors/,
      );
    } finally {
      await worker.close();
    }
    let reads = 0;
    const getter = {
      enumerable: true,
      get() {
        reads++;
        return "rounded";
      },
    };
    const accessor = Object.defineProperty(zone(), "blendShape", getter);
    const nonEnumerable = Object.defineProperty(zone(), "blendShape", {
      value: "rounded",
    });
    const inherited = Object.assign(
      Object.create({ blendShape: "rounded" }) as FlatZone,
      zone(),
    );
    for (const candidate of [accessor, nonEnumerable, inherited])
      expect(() => operations.cloneSnapshot(snapshot([candidate]))).toThrow(
        /blendShape/,
      );
    expect(reads).toBe(0);
    const mutable = zone({ blendShape: "rounded" });
    const steps = operations.cloneSnapshotSteps(snapshot([mutable]));
    let step = steps.next();
    while (!step.done && step.value !== "snapshot_clone_zone")
      step = steps.next();
    expect(step.done).toBe(false);
    Object.defineProperty(mutable, "blendShape", getter);
    expect(() => steps.next()).toThrow(/blendShape/);
    expect(reads).toBe(0);
    expect(() =>
      operations.cloneSnapshot(
        snapshot([
          zone({
            blendShape: "rounded",
            grassExclusionBounds: { minX: -14, maxX: 14, minZ: -14, maxZ: 14 },
          }),
        ]),
      ),
    ).toThrow(/rounded grading support/);
    expect(() =>
      operations.cloneSnapshot(
        snapshot([
          zone({
            blendShape: "rounded",
            grassExclusionBounds: { minX: -10, maxX: 10, minZ: -14, maxZ: 14 },
          }),
        ]),
      ),
    ).not.toThrow();
  });

  it("clones explicit grass bounds without changing grading indexes or synthesizing absent fields", async () => {
    const original = zone();
    const bounded = zone({
      grassExclusionBounds: { minX: -2, maxX: 3, minZ: -1, maxZ: 4 },
    });
    const input = snapshot([bounded]);
    const before = structuredClone(input);
    const cloned = operations.cloneSnapshot(input);
    expect(cloned).toEqual(before);
    expect(cloned.zones[0].grassExclusionBounds).not.toBe(
      bounded.grassExclusionBounds,
    );
    expect(
      operations.cloneSnapshot(snapshot([original])).zones[0],
    ).not.toHaveProperty("grassExclusionBounds");
    const oldIndex = operations.createZoneIndex(snapshot([original]), 100);
    const newIndex = operations.createZoneIndex(cloned, 100);
    expect(newIndex.indexedZoneReferences).toBe(oldIndex.indexedZoneReferences);
    expect(newIndex.bucketCount).toBe(oldIndex.bucketCount);
    for (const [x, z] of [
      [0, 0],
      [14, 14],
      [-50, -50],
      [50, 50],
      [200, 200],
    ])
      expect(newIndex.getZonesAt(x, z).map((value) => value.id)).toEqual(
        oldIndex.getZonesAt(x, z).map((value) => value.id),
      );
    bounded.grassExclusionBounds!.minX = -3;
    expect(cloned).toEqual(before);
    const worker = actualWorker();
    try {
      const result = await worker.execute({ snapshot: cloned });
      expect(result.error).toBeUndefined();
      expect(result.snapshot).toEqual(before);
      expect(result.indexedZoneReferences).toBe(oldIndex.indexedZoneReferences);
    } finally {
      await worker.close();
    }
  });

  it("rejects malformed grass-only bounds on host and emitted worker without invoking bound accessors", async () => {
    const good = { minX: -2, maxX: 3, minZ: -1, maxZ: 4 };
    const invalid: unknown[] = [
      undefined,
      null,
      false,
      [],
      {},
      { ...good, minX: NaN },
      { ...good, maxX: Infinity },
      { ...good, minZ: "-1" },
      { ...good, maxZ: undefined },
      { ...good, minX: 3 },
      { ...good, minZ: 5 },
      { ...good, minX: -14.00001 },
      { ...good, maxX: 14.00001 },
      { ...good, minZ: -14.00001 },
      { ...good, maxZ: 14.00001 },
    ].map((grassExclusionBounds) => ({ ...zone(), grassExclusionBounds }));
    for (const conflict of [
      { excludeGrass: false },
      { tileMask: new Set<string>() },
      { tileMaskTiles: [] },
      { tileMaskBounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } },
      {
        radialPond: {
          bedRadius: 1,
          bankInnerRadius: 2,
          bankOuterRadius: 3,
          bankHeight: 30,
        },
      },
    ])
      invalid.push({ ...zone(), grassExclusionBounds: good, ...conflict });
    const worker = actualWorker();
    try {
      for (const candidate of invalid) {
        const input = { ...snapshot(), zones: [candidate] };
        expect(() => operations.validateSnapshot(input)).toThrow(
          /grassExclusionBounds/,
        );
        expect(() => operations.cloneSnapshot(input)).toThrow(
          /grassExclusionBounds/,
        );
        expect((await worker.execute({ snapshot: input })).error).toMatch(
          /grassExclusionBounds/,
        );
      }
    } finally {
      await worker.close();
    }
    let reads = 0;
    const accessor = {
      get() {
        reads++;
        return good;
      },
      enumerable: true,
    };
    const inherited = Object.assign(
      Object.create({ grassExclusionBounds: good }) as FlatZone,
      zone(),
    );
    const getter = zone();
    Object.defineProperty(getter, "grassExclusionBounds", accessor);
    const inheritedGetter = Object.assign(
      Object.create(
        Object.defineProperty({}, "grassExclusionBounds", accessor),
      ) as FlatZone,
      zone(),
    );
    const inheritedComponent = Object.assign(
      Object.create({ minX: -2 }) as object,
      { maxX: 3, minZ: -1, maxZ: 4 },
    );
    const componentGetter = { ...good };
    Object.defineProperty(componentGetter, "minX", {
      get() {
        reads++;
        return -2;
      },
      enumerable: true,
    });
    for (const candidate of [
      inherited,
      getter,
      inheritedGetter,
      Object.assign(zone(), { grassExclusionBounds: inheritedComponent }),
      zone({ grassExclusionBounds: componentGetter }),
    ]) {
      expect(() =>
        operations.validateGrassExclusionBounds(candidate as FlatZone),
      ).toThrow(/grassExclusionBounds/);
      expect(() =>
        operations.cloneSnapshot({ ...snapshot(), zones: [candidate] }),
      ).toThrow(/grassExclusionBounds/);
    }
    expect(reads).toBe(0);
    const equalSupport = zone({
      grassExclusionBounds: { minX: -14, maxX: 14, minZ: -14, maxZ: 14 },
    });
    expect(() =>
      operations.validateGrassExclusionBounds(equalSupport),
    ).not.toThrow();
    // Yielded cloning must not trust metadata that changed after validation.
    const mutable = zone({ grassExclusionBounds: { ...good } });
    const steps = operations.cloneSnapshotSteps(snapshot([mutable]));
    let step = steps.next();
    while (!step.done && step.value !== "snapshot_clone_zone")
      step = steps.next();
    expect(step.done).toBe(false);
    Object.defineProperty(mutable, "grassExclusionBounds", accessor);
    expect(() => steps.next()).toThrow(/grassExclusionBounds/);
    expect(reads).toBe(0);
  });

  it("clones bounded all-LOD exclusion polygons and matches real-worker point queries without shaping terrain", async () => {
    const polygon = {
      id: "rock",
      minX: -2,
      maxX: 2,
      minZ: -2,
      maxZ: 2,
      vertices: [
        { x: -2, z: 0 },
        { x: 0, z: -2 },
        { x: 2, z: 0 },
        { x: 0, z: 2 },
      ],
    };
    const input = { ...snapshot([]), exclusionPolygons: [polygon] };
    const clone = operations.cloneSnapshot(input);
    expect(clone).toEqual(input);
    expect(clone.exclusionPolygons![0].vertices[0]).not.toBe(
      polygon.vertices[0],
    );
    expect(operations.cloneSnapshot(snapshot([]))).not.toHaveProperty(
      "exclusionPolygons",
    );
    const points = [
      [0, 0],
      [-2, 0],
      [0, 2],
      [1, 0.999],
      [1, 1.001],
      [1.9, 1.9],
      [3, 0],
    ];
    const expected = [true, true, true, true, false, false, false];
    expect(
      points.map(([x, z]) => operations.isGrassExcluded(clone, x, z)),
    ).toEqual(expected);
    const worker = actualWorker();
    try {
      const receipt = await worker.execute({ snapshot: clone, points });
      expect(receipt.error).toBeUndefined();
      expect(receipt.excluded).toEqual(expected);
      expect(receipt.snapshot.zones).toEqual([]);
    } finally {
      await worker.close();
    }
    for (const bad of [
      { ...polygon, minX: -3 },
      { ...polygon, vertices: [...polygon.vertices].reverse() },
      {
        ...polygon,
        vertices: [
          polygon.vertices[0],
          polygon.vertices[0],
          polygon.vertices[2],
        ],
      },
      {
        ...polygon,
        vertices: polygon.vertices.map((p, i) =>
          i === 1 ? { x: 0, z: 1 } : p,
        ),
      },
      {
        ...polygon,
        vertices: polygon.vertices.map((p, i) =>
          i === 1 ? { x: NaN, z: -2 } : p,
        ),
      },
    ])
      expect(() =>
        operations.validateSnapshot({ ...input, exclusionPolygons: [bad] }),
      ).toThrow();
    expect(() =>
      operations.validateSnapshot({
        ...input,
        exclusionPolygons: [polygon, polygon],
      }),
    ).toThrow();
    expect(() =>
      operations.validateSnapshot({
        ...input,
        exclusionPolygons: Array.from({ length: 33 }, (_, i) => ({
          ...polygon,
          id: String(i),
        })),
      }),
    ).toThrow();
  });

  it("admits the bounded 24-rock plus eight-post capacity identically in real workers and rejects a 33rd owner", async () => {
    expect(operations.limits.maxExclusionPolygons).toBe(32);
    const polygons = Array.from({ length: 33 }, (_, i) => ({
      id: `bounded-owner-${i}`,
      minX: i * 4,
      maxX: i * 4 + 0.3,
      minZ: 0,
      maxZ: 0.3,
      vertices: [
        { x: i * 4, z: 0 },
        { x: i * 4 + 0.3, z: 0 },
        { x: i * 4 + 0.3, z: 0.3 },
        { x: i * 4, z: 0.3 },
      ],
    }));
    const input = { ...snapshot([]), exclusionPolygons: polygons.slice(0, 32) };
    const clone = operations.cloneSnapshot(input);
    expect(clone.exclusionPolygons).toHaveLength(32);
    expect(clone.exclusionPolygons![31].vertices).not.toBe(
      polygons[31].vertices,
    );
    const points = polygons.slice(0, 32).flatMap((p) => [
      [p.minX + 0.15, 0.15],
      [p.maxX + 0.01, 0.15],
    ]);
    const expected = Array.from({ length: 32 }, () => [true, false]).flat();
    expect(
      points.map(([x, z]) => operations.isGrassExcluded(clone, x, z)),
    ).toEqual(expected);
    const worker = actualWorker();
    try {
      const admitted = await worker.execute({ snapshot: clone, points });
      expect(admitted.error).toBeUndefined();
      expect(admitted.excluded).toEqual(expected);
      expect(admitted.snapshot.exclusionPolygons).toEqual(
        input.exclusionPolygons,
      );
      const oversized = { ...input, exclusionPolygons: polygons };
      expect(() => operations.validateSnapshot(oversized)).toThrow();
      const rejected = await worker.execute({
        snapshot: oversized,
        points: [],
      });
      expect(rejected.error).toBeDefined();
    } finally {
      await worker.close();
    }
  });

  it("tests the complete swept blade box against convex silhouettes, not their over-wide bounding rectangles", () => {
    const polygon = {
      id: "rock",
      minX: -2,
      maxX: 2,
      minZ: -2,
      maxZ: 2,
      vertices: [
        { x: -2, z: 0 },
        { x: 0, z: -2 },
        { x: 2, z: 0 },
        { x: 0, z: 2 },
      ],
    };
    const overlap = (
      minX: number,
      maxX: number,
      minZ: number,
      maxZ: number,
    ) => {
      const steps = operations.intersectsExclusionSteps(polygon, {
        minX,
        maxX,
        minZ,
        maxZ,
      });
      let step = steps.next(),
        work = 0;
      while (!step.done) {
        work++;
        step = steps.next();
      }
      expect(work).toBeLessThanOrEqual(5);
      return step.value;
    };
    expect(overlap(1.5, 1.9, 1.5, 1.9)).toBe(false);
    expect(overlap(1.9, 2.1, -0.1, 0.1)).toBe(true);
    expect(overlap(2, 3, 0, 1)).toBe(true);
    expect(overlap(2.001, 3, 0, 1)).toBe(false);
    expect(overlap(-3, 3, -0.1, 0.1)).toBe(true);
    expect(overlap(-0.1, 0.1, -0.1, 0.1)).toBe(true);
  });

  it("keeps shared AABB misses strict and reads bounds only after the public initial yield", () => {
    const polygon: GrassTerrainExclusionPolygon = {
      id: "bounds-order",
      minX: -2,
      maxX: 2,
      minZ: -2,
      maxZ: 2,
      vertices: [
        { x: -2, z: -2 },
        { x: 2, z: -2 },
        { x: 2, z: 2 },
        { x: -2, z: 2 },
      ],
    };
    operations.validateSnapshot({
      ...snapshot([]),
      exclusionPolygons: [polygon],
    });
    for (const [box, expected] of [
      [{ minX: 2, maxX: 3, minZ: 0, maxZ: 1 }, true],
      [{ minX: -3, maxX: -2, minZ: 0, maxZ: 1 }, true],
      [{ minX: 0, maxX: 1, minZ: 2, maxZ: 3 }, true],
      [{ minX: 0, maxX: 1, minZ: -3, maxZ: -2 }, true],
      [{ minX: 2, maxX: 3, minZ: 2, maxZ: 3 }, true],
      [{ minX: 2 + 1e-10, maxX: 3, minZ: 0, maxZ: 1 }, false],
      [{ minX: -3, maxX: -2 - 1e-10, minZ: 0, maxZ: 1 }, false],
      [{ minX: 0, maxX: 1, minZ: 2 + 1e-10, maxZ: 3 }, false],
      [{ minX: 0, maxX: 1, minZ: -3, maxZ: -2 - 1e-10 }, false],
    ] as const) {
      expect(operations.exclusionBoundsOverlap(polygon, box)).toBe(expected);
      const steps = operations.intersectsExclusionSteps(polygon, box);
      const phases: string[] = [];
      let step = steps.next();
      while (!step.done) {
        phases.push(step.value);
        step = steps.next();
      }
      expect(step.value).toBe(expected);
      expect(phases).toEqual(
        expected
          ? ["polygon_bounds", ...Array(4).fill("polygon_edge")]
          : ["polygon_bounds"],
      );
    }
    // Change an actual query between resumptions: the initial bounds yield may
    // not eagerly decide the overlap before its caller has charged the work.
    const box = { minX: 10, maxX: 11, minZ: 0, maxZ: 1 };
    const steps = operations.intersectsExclusionSteps(polygon, box);
    expect(steps.next()).toEqual({ done: false, value: "polygon_bounds" });
    box.minX = 2;
    box.maxX = 3;
    expect(steps.next()).toEqual({ done: false, value: "polygon_edge" });
    for (let i = 1; i < 4; i++)
      expect(steps.next()).toEqual({ done: false, value: "polygon_edge" });
    expect(steps.next()).toEqual({ done: true, value: true });
  });

  it("resumes the maximum admitted mask without skipping validation or mutating input", () => {
    const tileMaskTiles = Array.from(
      { length: operations.limits.maxMaskTiles },
      (_, x) => ({ x, z: 0 }),
    );
    const input = snapshot([
      zone({
        tileMask: new Set(tileMaskTiles.map(({ x, z }) => `${x},${z}`)),
        tileMaskTiles,
        tileMaskBounds: {
          minX: 0,
          maxX: tileMaskTiles.length - 1,
          minZ: 0,
          maxZ: 0,
        },
      }),
    ]);
    const before = structuredClone(input);
    const steps = operations.validateSnapshotSteps(input);
    let masks = 0,
      advances = 0;
    let step = steps.next();
    while (!step.done) {
      advances++;
      if (step.value === "snapshot_mask") masks++;
      step = steps.next();
    }
    expect(step.value).toBe(input);
    expect(masks).toBe(tileMaskTiles.length * 2);
    expect(advances).toBe(tileMaskTiles.length * 2 + 3);
    expect(operations.validateSnapshot(input)).toBe(input);
    expect(input).toEqual(before);
    const copying = operations.cloneSnapshotSteps(input);
    let copiedMasks = 0,
      copiedTiles = 0;
    let copy = copying.next();
    while (!copy.done) {
      if (copy.value === "snapshot_clone_mask") copiedMasks++;
      if (copy.value === "snapshot_clone_tile") copiedTiles++;
      copy = copying.next();
    }
    expect(copiedMasks).toBe(tileMaskTiles.length);
    expect(copiedTiles).toBe(tileMaskTiles.length);
    expect(copy.value).toEqual(input);
    expect(copy.value.zones[0].tileMask).not.toBe(input.zones[0].tileMask);
    expect(copy.value.zones[0].tileMaskTiles![0]).not.toBe(
      input.zones[0].tileMaskTiles![0],
    );
    expect(input).toEqual(before);
  });

  it("does not publish a snapshot before validating a late invalid mask entry", () => {
    const input = snapshot([masked()]);
    input.zones[0].tileMaskTiles![2].x = 10;
    const steps = operations.validateSnapshotSteps(input);
    let masks = 0;
    expect(() => {
      for (const phase of steps) if (phase === "snapshot_mask") masks++;
    }).toThrow(/exactly match unique mask keys/);
    expect(masks).toBe(6);
    expect(() => operations.validateSnapshot(input)).toThrow(
      /exactly match unique mask keys/,
    );
    expect(steps.next()).toEqual({ done: true, value: undefined });
  });

  it("releases an interrupted snapshot traversal without changing the borrowed mask", () => {
    const input = snapshot([masked()]);
    const before = structuredClone(input);
    const steps = operations.validateSnapshotSteps(input);
    expect(steps.next().value).toBe("snapshot_header");
    expect(steps.next().value).toBe("snapshot_zone");
    expect(steps.next().value).toBe("snapshot_mask");
    steps.return(undefined as never);
    expect(steps.next()).toEqual({ done: true, value: undefined });
    expect(input).toEqual(before);
    expect(operations.validateSnapshot(input)).toBe(input);
  });

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
      expect(Object.prototype.hasOwnProperty.call(clone, "tileMaskTiles")).toBe(
        Object.prototype.hasOwnProperty.call(source, "tileMaskTiles"),
      );
      expect(
        Object.prototype.hasOwnProperty.call(clone, "tileMaskBounds"),
      ).toBe(Object.prototype.hasOwnProperty.call(source, "tileMaskBounds"));
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
      const composition = snapshot([compositionPond()]);
      const compositionResult = await worker.execute({
        snapshot: composition,
        clone: true,
      });
      expect(compositionResult.error).toBeUndefined();
      expect(compositionResult.snapshot).toEqual(composition);
      expect(compositionResult.compositionFrozen).toBe(true);
      const mineral = compositionPond();
      Object.assign(mineral.radialPond!.bankComposition!.sectors[0], {
        surface: "mineral-shore",
      });
      const mineralSnapshot = snapshot([mineral]);
      const mineralResult = await worker.execute({
        snapshot: mineralSnapshot,
        clone: true,
      });
      expect(mineralResult.error).toBeUndefined();
      expect(mineralResult.snapshot).toEqual(mineralSnapshot);
      expect(mineralResult.compositionFrozen).toBe(true);
      Object.assign(mineral.radialPond!.bankComposition!.sectors[0], {
        groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
      });
      expect(
        (await worker.execute({ snapshot: snapshot([mineral]), clone: true }))
          .error,
      ).toMatch(/mineral-shore.*groundCover/);
      const result = await worker.execute({
        snapshot: {
          ...snapshot([
            masked(),
            zone({
              id: "rounded",
              blendShape: "rounded",
              blendComposition: "smooth-union",
            }),
            sectorPond(),
            pairedSectorPond(),
          ]),
          exclusionPolygons: [
            {
              id: "worker-bounds",
              minX: -2,
              maxX: 2,
              minZ: -2,
              maxZ: 2,
              vertices: [
                { x: -2, z: -2 },
                { x: 2, z: -2 },
                { x: 2, z: 2 },
                { x: -2, z: 2 },
              ],
            },
          ],
        },
        points: [[0, 0]],
        boxes: [
          { minX: 2, maxX: 3, minZ: 0, maxZ: 1 },
          { minX: 2.001, maxX: 3, minZ: 0, maxZ: 1 },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.candidateIds).toEqual([
        ["L-footprint", "rounded", "sector-pond", "paired-sector-pond"],
      ]);
      expect(result.snapshot.zones[2].radialPond!.bankSectors).toEqual(
        sectorPond().radialPond!.bankSectors,
      );
      expect(result.snapshot.zones[3].radialPond!.bankSectors).toEqual(
        pairedSectorPond().radialPond!.bankSectors,
      );
      expect(result.snapshot.zones[1].blendShape).toBe("rounded");
      expect(result.snapshot.zones[1].blendComposition).toBe("smooth-union");
      expect(result.boxes).toEqual([
        {
          boundsOverlap: true,
          phases: ["polygon_bounds", ...Array(4).fill("polygon_edge")],
          intersects: true,
        },
        { boundsOverlap: false, phases: ["polygon_bounds"], intersects: false },
      ]);
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
