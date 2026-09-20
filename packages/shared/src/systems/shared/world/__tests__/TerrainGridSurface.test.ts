import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
  type TerrainGridTriangle,
  type TerrainGridBounds,
  type TerrainCellTopology,
} from "../TerrainGridSurface";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import { gridGeometry } from "./terrain-grid.fixture";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
  resolveDuelArenaFloorHeight,
} from "../../../../data/arena-grading";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import { BiomeType } from "../TerrainBiomeTypes";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

const sample = (): TerrainGridSample => ({
  height: 0,
  nx: 0,
  ny: 1,
  nz: 0,
  faceIndex: 0,
});

/** A genuinely indexed, nonplanar 4x4 subdivision in each of four cells.
 * The original regular-grid prefix and shared edge identities are retained. */
function denseEdgeGeometry(skinny = false) {
  const geometry = gridGeometry(2, 3, (x, z) => 20 + x * z),
    values = Array.from(geometry.getAttribute("position").array),
    ids = new Map<string, number>(),
    indices: number[] = [],
    offsets = [0];
  for (let id = 0; id < 9; id++)
    ids.set(`${values[id * 3]},${values[id * 3 + 2]}`, id);
  const vertex = (x: number, z: number) => {
    const key = `${x},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = values.length / 3;
      ids.set(key, id);
      values.push(x, 20 + x * z + Math.sin(x * 5 + z * 3) * 0.2, z);
    }
    return id;
  };
  for (let cellZ = 0; cellZ < 2; cellZ++)
    for (let cellX = 0; cellX < 2; cellX++) {
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 4; x++) {
          const x0 = -1 + cellX + x / 4,
            z0 = -1 + cellZ + z / 4,
            a = vertex(x0, z0),
            b = vertex(x0 + 0.25, z0),
            c = vertex(x0, z0 + 0.25),
            d = vertex(x0 + 0.25, z0 + 0.25);
          indices.push(a, c, b, b, c, d);
        }
      offsets.push(indices.length);
    }
  if (skinny)
    for (let id = 9; id < values.length / 3; id++)
      if (values[id * 3] === -0.75) values[id * 3] = Math.fround(-1 + 2 ** -24);
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(values), 3),
  );
  geometry.setIndex(indices);
  geometry.userData.terrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution: 3,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount: values.length / 3,
  } satisfies TerrainCellTopology);
  return geometry;
}

function finishPreparation(
  iterator: Generator<string, RetainedTerrainSurface, void>,
) {
  const phases: string[] = [];
  let maxStepMs = 0,
    maxStepPhase = "initial",
    previousPhase = "initial";
  for (let steps = 0; steps < 100_000; steps++) {
    const started = performance.now(),
      next = iterator.next();
    const elapsed = performance.now() - started;
    if (elapsed > maxStepMs) {
      maxStepMs = elapsed;
      maxStepPhase = previousPhase;
    }
    if (next.done)
      return { surface: next.value, phases, maxStepMs, maxStepPhase };
    expect(typeof next.value).toBe("string");
    phases.push(next.value);
    previousPhase = next.value;
  }
  throw new Error(
    "Retained preparation failed to terminate within its bounded fixture",
  );
}

/** Independent indexed fixture: two five-face fans share an edge cut; the
 * lower cells retain their two original faces. Nonplanar fan vertices ensure
 * a regular-grid/bilinear or canonical stand-in cannot pass the ray oracle. */
function refinedGeometry(size = 2, skirts = true) {
  const geometry = gridGeometry(size, 3, (x, z) => 20 + x * 0.2 + z * 0.1);
  const values = Array.from(geometry.getAttribute("position").array);
  values.push(
    0,
    20.7,
    -size / 4,
    -size / 4,
    23,
    -size / 4,
    size / 4,
    19.2,
    -size / 4,
  );
  const indices: number[] = [],
    offsets = [0];
  for (const [center, boundary] of [
    [10, [0, 3, 4, 9, 1]],
    [11, [1, 9, 4, 5, 2]],
  ] as const) {
    for (let i = 0; i < boundary.length; i++)
      indices.push(center, boundary[i], boundary[(i + 1) % boundary.length]);
    offsets.push(indices.length);
  }
  indices.push(3, 6, 4, 4, 6, 7);
  offsets.push(indices.length);
  indices.push(4, 7, 5, 5, 7, 8);
  offsets.push(indices.length);
  if (skirts) {
    values.push(-size / 2, 15, -size / 2, 0, 15, -size / 2);
    indices.push(0, 12, 1, 1, 12, 13);
  }
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(values), 3),
  );
  geometry.setIndex(indices);
  const topology: TerrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution: 3,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount: 12,
  });
  geometry.userData.terrainCellTopology = topology;
  return { geometry, topology };
}

/** One nonplanar central cell, surrounded by four exact regular neighbors. */
function isolatedRefinedGeometry(splitSide = -1, duplicateCorner = false) {
  const geometry = gridGeometry(3, 4, (x, z) => 20 + x * 0.2 + z * 0.1),
    values = Array.from(geometry.getAttribute("position").array),
    indices: number[] = [],
    offsets = [0],
    boundary = [5, 9, 10, 6];
  values.push(0, 23, 0); // The fan center is vertex 16.
  if (splitSide >= 0) {
    const a = boundary[splitSide],
      b = boundary[(splitSide + 1) % 4];
    values.push(
      (values[a * 3] + values[b * 3]) / 2,
      (values[a * 3 + 1] + values[b * 3 + 1]) / 2,
      (values[a * 3 + 2] + values[b * 3 + 2]) / 2,
    );
    boundary.splice(splitSide + 1, 0, 17);
  } else if (duplicateCorner) {
    values.push(values[15], values[16], values[17]);
    boundary[0] = 17;
  }
  for (let z = 0; z < 3; z++)
    for (let x = 0; x < 3; x++) {
      const a = z * 4 + x;
      if (x === 1 && z === 1)
        for (let i = 0; i < boundary.length; i++)
          indices.push(16, boundary[i], boundary[(i + 1) % boundary.length]);
      else indices.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);
      offsets.push(indices.length);
    }
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(values), 3),
  );
  geometry.setIndex(indices);
  const topology: TerrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution: 4,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount: values.length / 3,
  });
  geometry.userData.terrainCellTopology = topology;
  return { geometry, topology };
}

describe("retained locally indexed cell topology", () => {
  it("samples exact outer boundaries of indexed Float32 grids without barycentric cancellation", () => {
    const resolution = 128,
      size = 100,
      geometry = gridGeometry(
        size,
        resolution,
        (x, z) => 28 + Math.sin(x * 0.1) * 0.4 + z * 0.02,
      );
    const offsets = Array.from(
      { length: (resolution - 1) ** 2 + 1 },
      (_, cell) => cell * 6,
    );
    geometry.userData.terrainCellTopology = Object.freeze({
      schemaVersion: 1,
      resolution,
      cellIndexOffsets: Object.freeze(offsets),
      surfaceVertexCount: resolution ** 2,
    });
    const material = new THREE.MeshBasicMaterial(),
      mesh = new THREE.Mesh(geometry, material),
      ray = new THREE.Raycaster(),
      down = new THREE.Vector3(0, -1, 0),
      origin = new THREE.Vector3();
    mesh.updateMatrixWorld(true);
    try {
      const surface = new RetainedTerrainSurface(
          1,
          "indexed-edge",
          350,
          350,
          size,
          resolution,
          geometry,
        ),
        out = sample();
      // Reproduce the four exact world-boundary misses from the real retained
      // island, then scan every side including corners at its 0.1 m spacing.
      const points: [number, number][] = [338.6, 338.7, 359.9, 361.1].map(
        (worldX) => [worldX - 350, 50],
      );
      for (let i = 0; i <= 1000; i++) {
        const coordinate = 300 + i * 0.1 - 350;
        points.push(
          [coordinate, -50],
          [coordinate, 50],
          [-50, coordinate],
          [50, coordinate],
        );
      }
      for (const [x, z] of points) {
        expect(surface.sample(x, z, out), `indexed edge ${x},${z}`).toBe(true);
        ray.set(origin.set(x, 100, z), down);
        const hits = ray.intersectObject(mesh, false);
        expect(hits.length, `ray edge ${x},${z}`).toBeGreaterThan(0);
        expect(out.height).toBeCloseTo(hits[0].point.y, 10);
        expect(out.ny).toBeGreaterThan(0);
      }
      // A mathematically outside point still rejects; no widened admission.
      expect(surface.sample(50 + Number.EPSILON * 256, 0, out)).toBe(false);
      expect(surface.sample(0, -50 - Number.EPSILON * 256, out)).toBe(false);
    } finally {
      geometry.dispose();
      material.dispose();
    }
  });

  it("stages absent-metadata grids in bounded batches and returns the same synchronous surface truth", () => {
    const geometry = gridGeometry(100, 64, (x, z) => 20 + 0.01 * x * z);
    try {
      const sync = new RetainedTerrainSurface(
          1,
          "regular",
          350,
          450,
          100,
          64,
          geometry,
        ),
        prepared = finishPreparation(
          RetainedTerrainSurface.prepare(
            1,
            "regular",
            350,
            450,
            100,
            64,
            geometry,
          ),
        ),
        a = sample(),
        b = sample();
      expect(prepared.phases.filter((phase) => phase === "grid")).toHaveLength(
        32,
      );
      expect(prepared.phases[0]).toBe("admission");
      expect(prepared.phases[prepared.phases.length - 1]).toBe("finalize");
      for (let z = -49.5; z < 50; z += 3)
        for (let x = -49.5; x < 50; x += 3) {
          expect(sync.sample(x, z, a)).toBe(true);
          expect(prepared.surface.sample(x, z, b)).toBe(true);
          expect(b).toEqual(a);
        }
      expect(prepared.surface.matchesGeometry(geometry)).toBe(true);
    } finally {
      geometry.dispose();
    }
  });

  it("rechecks borrowed geometry, attributes, arrays, versions and metadata on resume and immediately before completion", () => {
    const changes: ((
      g: THREE.BufferGeometry,
      t: TerrainCellTopology,
    ) => void)[] = [
      (g) => {
        g.uuid = "replaced";
      },
      (g) => {
        const p = g.getAttribute("position");
        g.setAttribute("position", new THREE.BufferAttribute(p.array, 3));
      },
      (g) => {
        const p = g.getAttribute("position");
        // Deliberate runtime corruption despite the public readonly type.
        expect(Reflect.set(p, "array", p.array.slice())).toBe(true);
      },
      (g) => {
        const i = g.getIndex()!;
        i.array = i.array.slice();
      },
      (g) => {
        g.getIndex()!.normalized = true;
      },
      (g) => {
        const p = g.getAttribute("position");
        p.setY(0, p.getY(0) + 1);
        p.needsUpdate = true;
      },
      (g) => {
        const i = g.getIndex()!;
        i.setX(0, 8);
        i.needsUpdate = true;
      },
      (g, t) => {
        g.userData.terrainCellTopology = Object.freeze({ ...t });
      },
      (g) => {
        delete g.userData.terrainCellTopology;
      },
      (g) => {
        g.userData = { ...g.userData };
      },
      (g) => {
        Object.defineProperty(g.userData, "terrainCellTopology", {
          get() {
            throw new Error("must not invoke accessor");
          },
        });
      },
    ];
    for (const phase of ["admission", "topology-side", "finalize"])
      for (const change of changes) {
        const { geometry, topology } = refinedGeometry(),
          iterator = RetainedTerrainSurface.prepare(
            1,
            "mutation",
            0,
            0,
            2,
            3,
            geometry,
          );
        let disposals = 0;
        geometry.addEventListener("dispose", () => {
          disposals++;
        });
        try {
          for (;;) {
            const next = iterator.next();
            expect(next.done).toBe(false);
            if (next.value === phase) break;
          }
          change(geometry, topology);
          expect(() => iterator.next()).toThrow(
            "Retained terrain geometry changed during admission",
          );
          expect(iterator.next()).toEqual({ done: true, value: undefined });
          expect(disposals).toBe(0);
        } finally {
          geometry.dispose();
        }
      }
  });

  it("cancels or throws through each suspended validation phase without disposing borrowed geometry or leaking an admission proof", () => {
    const initial = refinedGeometry(),
      phases = [
        ...new Set(
          finishPreparation(
            RetainedTerrainSurface.prepare(
              1,
              "phases",
              0,
              0,
              2,
              3,
              initial.geometry,
            ),
          ).phases,
        ),
      ];
    initial.geometry.dispose();
    for (const phase of phases)
      for (const throwing of [false, true]) {
        const { geometry } = refinedGeometry(),
          iterator = RetainedTerrainSurface.prepare(
            1,
            "cancel",
            0,
            0,
            2,
            3,
            geometry,
          );
        let disposals = 0;
        geometry.addEventListener("dispose", () => {
          disposals++;
        });
        try {
          for (;;) {
            const next = iterator.next();
            expect(next.done).toBe(false);
            if (next.value === phase) break;
          }
          if (throwing) {
            const failure = new Error(`caller cancellation at ${phase}`);
            expect(() => iterator.throw(failure)).toThrow(failure);
          } else
            expect(iterator.return(undefined as never)).toEqual({
              done: true,
              value: undefined,
            });
          expect(iterator.next()).toEqual({ done: true, value: undefined });
          expect(disposals).toBe(0);
          expect(
            new RetainedTerrainSurface(
              1,
              "fresh",
              0,
              0,
              2,
              3,
              geometry,
            ).matchesGeometry(geometry),
          ).toBe(true);
          // A later ordinary constructor must still validate, not consume a
          // canceled or previously consumed private proof.
          geometry.getIndex()!.setX(0, 60000);
          expect(
            () => new RetainedTerrainSurface(1, "fresh", 0, 0, 2, 3, geometry),
          ).toThrow("indexed cell coverage");
        } finally {
          geometry.dispose();
        }
      }
    const invalid = new THREE.BufferGeometry();
    try {
      const lazy = RetainedTerrainSurface.prepare(
        1,
        "unstarted",
        0,
        0,
        2,
        3,
        invalid,
      );
      expect(lazy.return(undefined as never)).toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      invalid.dispose();
    }
  });

  it("preserves strict synchronous error messages under stepped admission and does not invoke metadata getters", () => {
    let getterCalls = 0;
    const changes: ((g: THREE.BufferGeometry) => void)[] = [
      (g) => {
        g.userData.terrainCellTopology = NaN;
      },
      (g) => {
        g.userData.terrainCellTopology = undefined;
      },
      (g) => {
        Object.defineProperty(g.userData, "terrainCellTopology", {
          get() {
            getterCalls++;
            return undefined;
          },
        });
      },
      (g) => {
        g.getAttribute("position").setX(0, 12);
      },
      (g) => {
        g.getIndex()!.setX(0, 60000);
      },
    ];
    for (const change of changes) {
      const { geometry } = refinedGeometry();
      try {
        change(geometry);
        let message = "";
        try {
          new RetainedTerrainSurface(1, "invalid", 0, 0, 2, 3, geometry);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          message = (error as Error).message;
        }
        expect(message).not.toBe("");
        expect(() =>
          finishPreparation(
            RetainedTerrainSurface.prepare(1, "invalid", 0, 0, 2, 3, geometry),
          ),
        ).toThrow(message);
      } finally {
        geometry.dispose();
      }
    }
    expect(getterCalls).toBe(0);
  });

  it("interleaves independent preparations and binds each one-use completion to its exact owner", () => {
    const first = refinedGeometry(),
      second = refinedGeometry(100),
      a = RetainedTerrainSurface.prepare(
        11,
        "first",
        350,
        450,
        2,
        3,
        first.geometry,
      ),
      b = RetainedTerrainSurface.prepare(
        22,
        "second",
        -350,
        -450,
        100,
        3,
        second.geometry,
      );
    try {
      for (;;) {
        const next = a.next();
        expect(next.done).toBe(false);
        if (next.value === "finalize") break;
      }
      const secondSurface = finishPreparation(b).surface,
        completed = a.next();
      expect(completed.done).toBe(true);
      if (!completed.done) throw new Error("Expected first completion");
      expect(completed.value.nodeId).toBe(11);
      expect(completed.value.terrainProfileIdentity).toBe("first");
      expect(completed.value.matchesGeometry(first.geometry)).toBe(true);
      expect(completed.value.matchesGeometry(second.geometry)).toBe(false);
      expect(secondSurface.nodeId).toBe(22);
      expect(secondSurface.matchesGeometry(second.geometry)).toBe(true);
      expect(a.next()).toEqual({ done: true, value: undefined });
    } finally {
      first.geometry.dispose();
      second.geometry.dispose();
    }
  });

  it("admits fully regular metadata and equivalent non-fast-path face orders without changing indexed truth", () => {
    for (const reordered of [false, true]) {
      const geometry = gridGeometry(3, 4, (x, z) => 20 + x * 0.2 + z * 0.1),
        index = geometry.getIndex()!;
      if (reordered) {
        // Cyclic vertex ordering and swapping complete faces preserve winding
        // and coverage, but must not match the exact analytic fast-path pattern.
        const a = Array.from(index.array.slice(0, 6));
        for (const [i, value] of [a[4], a[5], a[3], a[1], a[2], a[0]].entries())
          index.setX(i, value);
      }
      geometry.userData.terrainCellTopology = Object.freeze({
        schemaVersion: 1,
        resolution: 4,
        cellIndexOffsets: Object.freeze(
          Array.from({ length: 10 }, (_, i) => i * 6),
        ),
        surfaceVertexCount: 16,
      });
      try {
        const surface = new RetainedTerrainSurface(
            1,
            "regular-metadata",
            0,
            0,
            3,
            4,
            geometry,
          ),
          out = sample(),
          p = geometry.getAttribute("position");
        for (let face = 0; face < 18; face++) {
          const a = index.getX(face * 3),
            b = index.getX(face * 3 + 1),
            c = index.getX(face * 3 + 2);
          expect(
            surface.sample(
              p.getX(a) * 0.2 + p.getX(b) * 0.3 + p.getX(c) * 0.5,
              p.getZ(a) * 0.2 + p.getZ(b) * 0.3 + p.getZ(c) * 0.5,
              out,
            ),
          ).toBe(true);
          expect(out.faceIndex).toBe(face);
          expect(out.height).toBeCloseTo(
            p.getY(a) * 0.2 + p.getY(b) * 0.3 + p.getY(c) * 0.5,
            12,
          );
        }
      } finally {
        geometry.dispose();
      }
    }
  });

  it("proves all four refined-to-regular interfaces and rejects split edges or duplicate endpoint IDs", () => {
    const { geometry } = isolatedRefinedGeometry();
    try {
      const surface = new RetainedTerrainSurface(
          1,
          "isolated",
          0,
          0,
          3,
          4,
          geometry,
        ),
        out = sample();
      expect(surface.sample(0, 0, out)).toBe(true);
      expect(out.height).toBe(23);
    } finally {
      geometry.dispose();
    }
    // Each altered center cell still has positive faces and complete area.
    // Its regular neighbor must nevertheless reject the unmatched interface.
    for (const side of [0, 1, 2, 3, -1]) {
      const { geometry } = isolatedRefinedGeometry(side, side === -1);
      try {
        expect(
          () =>
            new RetainedTerrainSurface(1, "unmatched", 0, 0, 3, 4, geometry),
        ).toThrow("indexed cell coverage");
      } finally {
        geometry.dispose();
      }
    }
  });

  it("does not skip almost-regular corruption or an unused appended main vertex", () => {
    for (const corruption of [
      "fold",
      "duplicate-face",
      "outside",
      "unused",
    ] as const) {
      const { geometry, topology } = isolatedRefinedGeometry(),
        index = geometry.getIndex()!;
      try {
        if (corruption === "fold") {
          const a = index.getX(0);
          index.setX(0, index.getX(1));
          index.setX(1, a);
        } else if (corruption === "duplicate-face") {
          for (let i = 0; i < 3; i++) index.setX(i + 3, index.getX(i));
        } else if (corruption === "outside") index.setX(0, 15);
        else {
          const p = geometry.getAttribute("position"),
            values = new Float32Array(p.array.length + 3);
          values.set(p.array);
          values.set([0, 24, 0], p.array.length);
          geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(values, 3),
          );
          geometry.userData.terrainCellTopology = Object.freeze({
            ...topology,
            surfaceVertexCount: topology.surfaceVertexCount + 1,
          });
        }
        expect(
          () => new RetainedTerrainSurface(1, "corrupt", 0, 0, 3, 4, geometry),
        ).toThrow("indexed cell coverage");
      } finally {
        geometry.dispose();
      }
    }
  });

  it.each([64, 128])(
    "admits actual generator floor-collar topology and samples/traverses its real indexed faces, resolution=%i",
    (resolution) => {
      const grade = getDuelArenaGradeHeight(),
        floors = createDuelArenaFloorZones(getDuelArenaConfig(), grade);
      const height = (x: number, z: number) => {
        for (const floor of floors) {
          const value = resolveDuelArenaFloorHeight(floor, x, z, grade);
          if (value !== null) return value;
        }
        return grade;
      };
      // An analytic numerical provider with the real authored floor resolver;
      // both production generation stages and the retained owner run unchanged.
      const provider: FullTerrainProvider = {
        terrainProfileIdentity: worldTerrainProfileIdentity(
          COMPACT_WORLD_TERRAIN_PROFILE,
        ),
        TILE_SIZE: 100,
        WATER_LEVEL_NORMALIZED: 0.32,
        SHORELINE_THRESHOLD: 0.25,
        SHORELINE_STRENGTH: 0.6,
        MAX_HEIGHT: 50,
        surfaceRefinementZones: floors.map((zone) => ({
          minX: zone.centerX - zone.width / 2,
          maxX: zone.centerX + zone.width / 2,
          minZ: zone.centerZ - zone.depth / 2,
          maxZ: zone.centerZ + zone.depth / 2,
          blendRadius: zone.blendRadius,
        })),
        getHeightAtComputed: height,
        getFlatZoneHeight: height,
        calculateRoadInfluenceAtVertex: () => 0,
        computeBiomeWeightsAtPosition: () => ({
          biomeWeightMap: new Map([[BiomeType.Forest, 1]]),
          totalWeight: 1,
        }),
        computeBiomeWeightsByPosition: () => ({ [BiomeType.Forest]: 1 }),
        getBiomeId: () => 0,
        getBiomeColor: () => ({ r: 0.2, g: 0.4, b: 0.1 }),
      };
      const worker = generateQuadChunkDataSync(
          350,
          400,
          100,
          resolution,
          provider,
        ),
        { geometry } = assembleQuadChunkGeometry(worker, provider, 3),
        material = new THREE.MeshBasicMaterial(),
        mesh = new THREE.Mesh(geometry, material),
        ray = new THREE.Raycaster(),
        origin = new THREE.Vector3(),
        down = new THREE.Vector3(0, -1, 0);
      mesh.position.set(350, 0, 400);
      mesh.updateMatrixWorld(true);
      try {
        const admissionStart = performance.now(),
          surface = new RetainedTerrainSurface(
            1,
            provider.terrainProfileIdentity,
            350,
            400,
            100,
            resolution,
            geometry,
          ),
          admissionMs = performance.now() - admissionStart,
          prepared = finishPreparation(
            RetainedTerrainSurface.prepare(
              1,
              provider.terrainProfileIdentity,
              350,
              400,
              100,
              resolution,
              geometry,
            ),
          ),
          topology = geometry.userData
            .terrainCellTopology as TerrainCellTopology,
          p = geometry.getAttribute("position"),
          index = geometry.getIndex()!,
          mainFaces =
            topology.cellIndexOffsets[topology.cellIndexOffsets.length - 1] / 3,
          out = sample(),
          steppedOut = sample(),
          xs = new Float64Array(mainFaces),
          zs = new Float64Array(mainFaces),
          ys = new Float64Array(mainFaces);
        for (let face = 0; face < mainFaces; face++) {
          const a = index.getX(face * 3),
            b = index.getX(face * 3 + 1),
            c = index.getX(face * 3 + 2);
          xs[face] = p.getX(a) * 0.2 + p.getX(b) * 0.3 + p.getX(c) * 0.5;
          zs[face] = p.getZ(a) * 0.2 + p.getZ(b) * 0.3 + p.getZ(c) * 0.5;
          ys[face] = p.getY(a) * 0.2 + p.getY(b) * 0.3 + p.getY(c) * 0.5;
        }
        let misses = 0,
          wrongFaces = 0,
          steppedMismatches = 0,
          maxHeightError = 0;
        const scalarStart = performance.now();
        for (let face = 0; face < mainFaces; face++) {
          if (!surface.sample(xs[face], zs[face], out)) misses++;
          else {
            if (out.faceIndex !== face) wrongFaces++;
            maxHeightError = Math.max(
              maxHeightError,
              Math.abs(out.height - ys[face]),
            );
          }
          if (
            !prepared.surface.sample(xs[face], zs[face], steppedOut) ||
            steppedOut.height !== out.height ||
            steppedOut.nx !== out.nx ||
            steppedOut.ny !== out.ny ||
            steppedOut.nz !== out.nz ||
            steppedOut.faceIndex !== out.faceIndex
          )
            steppedMismatches++;
        }
        const scalarMs = performance.now() - scalarStart;
        const cursor = surface.createTriangleCursor({
            minX: -50,
            maxX: 50,
            minZ: -50,
            maxZ: 50,
          }),
          triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let visited = 0,
          wrongCoordinates = 0;
        const cursorStart = performance.now();
        while (cursor.next(triangle)) {
          if (triangle[9] !== visited) wrongCoordinates++;
          for (let corner = 0; corner < 3; corner++) {
            const v = index.getX(visited * 3 + corner);
            if (
              triangle[corner * 3] !== p.getX(v) ||
              triangle[corner * 3 + 1] !== p.getY(v) ||
              triangle[corner * 3 + 2] !== p.getZ(v)
            )
              wrongCoordinates++;
          }
          visited++;
        }
        const cursorMs = performance.now() - cursorStart;
        process.stdout.write(
          `Retained actual indexed geometry ${JSON.stringify({ resolution, surfaceVertices: topology.surfaceVertexCount, mainFaces, offsetNumericBytesLowerBound: topology.cellIndexOffsets.length * 8, admissionMs, preparationSteps: prepared.phases.length + 1, preparationMaxStepMs: prepared.maxStepMs, preparationMaxStepPhase: prepared.maxStepPhase, scalarQueries: mainFaces, scalarMs, cursorFaces: visited, cursorMs, misses, wrongFaces, wrongCoordinates, steppedMismatches, maxHeightError, nativeOrPerformanceAcceptance: false })}\n`,
        );
        expect(misses).toBe(0);
        expect(wrongFaces).toBe(0);
        expect(steppedMismatches).toBe(0);
        expect(prepared.phases).toContain("metadata-offsets");
        expect(prepared.phases).toContain("topology-faces");
        expect(prepared.phases).toContain("topology-used-vertices");
        expect(maxHeightError).toBeLessThan(1e-10);
        expect(visited).toBe(mainFaces);
        expect(wrongCoordinates).toBe(0);
        expect(index.count / 3).toBeGreaterThan(mainFaces);
        for (
          let face = 0;
          face < mainFaces;
          face += Math.max(1, Math.floor(mainFaces / 48))
        ) {
          expect(surface.sample(xs[face], zs[face], out)).toBe(true);
          origin.set(350 + xs[face], 100, 400 + zs[face]);
          ray.set(origin, down);
          const hit = ray.intersectObject(mesh)[0];
          expect(hit).toBeDefined();
          expect(hit.faceIndex).toBe(face);
          expect(out.height).toBeCloseTo(hit.point.y, 8);
          expect(out.nx).toBeCloseTo(hit.face!.normal.x, 9);
          expect(out.ny).toBeCloseTo(hit.face!.normal.y, 9);
          expect(out.nz).toBeCloseTo(hit.face!.normal.z, 9);
        }
        for (let v = 0; v < topology.surfaceVertexCount; v++) {
          expect(surface.sample(p.getX(v), p.getZ(v), out)).toBe(true);
          expect(out.height).toBeCloseTo(p.getY(v), 8);
        }
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
        material.dispose();
      }
    },
  );

  it.each([2, 100, 0.03125])(
    "samples actual indexed faces and normals against Three ray intersections, size=%s",
    (size) => {
      const { geometry, topology } = refinedGeometry(size);
      const surface = new RetainedTerrainSurface(
        7,
        "refined",
        350,
        450,
        size,
        3,
        geometry,
      );
      const material = new THREE.MeshBasicMaterial(),
        mesh = new THREE.Mesh(geometry, material),
        ray = new THREE.Raycaster(),
        out = sample();
      mesh.position.set(350, 0, 450);
      mesh.updateMatrixWorld(true);
      const p = geometry.getAttribute("position"),
        index = geometry.getIndex()!;
      try {
        for (let face = 0; face < topology.cellIndexOffsets[4] / 3; face++) {
          const a = index.getX(face * 3),
            b = index.getX(face * 3 + 1),
            c = index.getX(face * 3 + 2);
          const x = p.getX(a) * 0.2 + p.getX(b) * 0.3 + p.getX(c) * 0.5,
            z = p.getZ(a) * 0.2 + p.getZ(b) * 0.3 + p.getZ(c) * 0.5;
          expect(surface.sample(x, z, out)).toBe(true);
          ray.set(
            new THREE.Vector3(350 + x, 100, 450 + z),
            new THREE.Vector3(0, -1, 0),
          );
          const hit = ray.intersectObject(mesh)[0];
          expect(hit).toBeDefined();
          expect(out.faceIndex).toBe(face);
          expect(out.faceIndex).toBe(hit.faceIndex);
          expect(out.height).toBeCloseTo(hit.point.y, 8);
          expect(out.nx).toBeCloseTo(hit.face!.normal.x, 10);
          expect(out.ny).toBeCloseTo(hit.face!.normal.y, 10);
          expect(out.nz).toBeCloseTo(hit.face!.normal.z, 10);
        }
        for (let i = 0; i < topology.surfaceVertexCount; i++) {
          expect(surface.sample(p.getX(i), p.getZ(i), out)).toBe(true);
          expect(out.height).toBeCloseTo(p.getY(i), 10);
        }
        expect(surface.sample(-size / 4, -size / 4, out)).toBe(true);
        expect(out.height).toBe(23);
        expect(surface.sample(size, 0, out)).toBe(false);
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
        material.dispose();
      }
    },
  );

  it("traverses exact indexed ranges at closed boundaries, retaining face order, budgets, and independent cursors without skirts", () => {
    const { geometry, topology } = refinedGeometry();
    const surface = new RetainedTerrainSurface(
        1,
        "indexed",
        0,
        0,
        2,
        3,
        geometry,
      ),
      p = geometry.getAttribute("position"),
      index = geometry.getIndex()!;
    const before = {
      positions: p.array.slice(),
      indices: index.array.slice(),
      offsets: [...topology.cellIndexOffsets],
    };
    try {
      for (const bounds of [
        { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
        { minX: 0, maxX: 0, minZ: -0.5, maxZ: -0.5 },
        { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
        { minX: -0.9, maxX: -0.1, minZ: 0.1, maxZ: 0.9 },
        { minX: -2, maxX: -1.1, minZ: -1, maxZ: 1 },
      ]) {
        const expected: number[] = [];
        for (let z = 0; z < 2; z++)
          for (let x = 0; x < 2; x++) {
            if (
              x - 1 > bounds.maxX ||
              x < bounds.minX ||
              z - 1 > bounds.maxZ ||
              z < bounds.minZ
            )
              continue;
            const cell = z * 2 + x;
            for (
              let offset = topology.cellIndexOffsets[cell];
              offset < topology.cellIndexOffsets[cell + 1];
              offset += 3
            )
              expected.push(offset / 3);
          }
        const cursor = surface.createTriangleCursor(bounds),
          out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const faces: number[] = [];
        while (cursor.next(out)) {
          faces.push(out[9]);
          for (let corner = 0; corner < 3; corner++) {
            const v = index.getX(out[9] * 3 + corner);
            expect(out.slice(corner * 3, corner * 3 + 3)).toEqual([
              p.getX(v),
              p.getY(v),
              p.getZ(v),
            ]);
          }
        }
        expect(faces).toEqual(expected);
        const terminal = [...out];
        expect(cursor.next(out)).toBe(false);
        expect(out).toEqual(terminal);
        for (const budget of new Set([
          0,
          1,
          Math.max(0, expected.length - 1),
          expected.length,
          expected.length + 1,
        ])) {
          const visited: number[] = [];
          const receipt = surface.visitTrianglesInBounds(
            bounds,
            (...v) => visited.push(v[9]),
            budget,
          );
          expect(visited).toEqual(expected.slice(0, budget));
          expect(receipt).toEqual({
            visited: Math.min(budget, expected.length),
            exhausted: expected.length > budget,
          });
        }
      }
      const all = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
        a = surface.createTriangleCursor(all),
        b = surface.createTriangleCursor(all),
        out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 7; i++) {
        expect(a.next(out)).toBe(true);
        expect(out[9]).toBe(i);
      }
      expect(b.next(out)).toBe(true);
      expect(out[9]).toBe(0);
      expect(a.next(out)).toBe(true);
      expect(out[9]).toBe(7);
      expect(p.array).toEqual(before.positions);
      expect(index.array).toEqual(before.indices);
      expect(topology.cellIndexOffsets).toEqual(before.offsets);
    } finally {
      geometry.dispose();
    }
  });

  it("rejects mutable, inherited, accessor, sparse and malformed metadata without invoking getters", () => {
    let getters = 0;
    const cases: ((
      geometry: THREE.BufferGeometry,
      topology: TerrainCellTopology,
    ) => void)[] = [
      (g) => {
        g.userData.terrainCellTopology = undefined;
      },
      (g, t) => {
        g.userData.terrainCellTopology = { ...t };
      },
      (g, t) => {
        g.userData.terrainCellTopology = Object.freeze({
          ...t,
          cellIndexOffsets: [...t.cellIndexOffsets],
        });
      },
      (g, t) => {
        g.userData.terrainCellTopology = Object.freeze({
          ...t,
          cellIndexOffsets: new Uint32Array(t.cellIndexOffsets),
        });
      },
      (g, t) => {
        g.userData = Object.create({ terrainCellTopology: t });
      },
      (g, t) => {
        Object.defineProperty(g.userData, "terrainCellTopology", {
          get: () => {
            getters++;
            return t;
          },
        });
      },
      (g, t) => {
        g.userData.terrainCellTopology = Object.freeze({
          ...t,
          get surfaceVertexCount() {
            getters++;
            return 12;
          },
        });
      },
      (g, t) => {
        const a = [...t.cellIndexOffsets];
        Object.defineProperty(a, "1", {
          get: () => {
            getters++;
            return 15;
          },
          enumerable: true,
        });
        g.userData.terrainCellTopology = Object.freeze({
          ...t,
          cellIndexOffsets: Object.freeze(a),
        });
      },
      (g, t) => {
        const a = [...t.cellIndexOffsets];
        delete a[1];
        g.userData.terrainCellTopology = Object.freeze({
          ...t,
          cellIndexOffsets: Object.freeze(a),
        });
      },
      ...[
        { schemaVersion: 2 },
        { resolution: 4 },
        { surfaceVertexCount: 8 },
        { surfaceVertexCount: 131073 },
        { extra: true },
        { cellIndexOffsets: Object.freeze([0, 15, 30, 36, 43]) },
        { cellIndexOffsets: Object.freeze([0, 15, 15, 36, 42]) },
        { cellIndexOffsets: Object.freeze([0, 1539, 1545, 1551, 1557]) },
      ].map((patch) => (g: THREE.BufferGeometry, t: TerrainCellTopology) => {
        g.userData.terrainCellTopology = Object.freeze({ ...t, ...patch });
      }),
    ];
    for (const change of cases) {
      const { geometry, topology } = refinedGeometry();
      try {
        change(geometry, topology);
        expect(
          () => new RetainedTerrainSurface(1, "invalid", 0, 0, 2, 3, geometry),
        ).toThrow("Invalid");
      } finally {
        geometry.dispose();
      }
    }
    expect(getters).toBe(0);
  });

  it("rejects folded, out-of-cell, degenerate, incomplete and overlapping actual indexed faces", () => {
    const cases: ((g: THREE.BufferGeometry) => void)[] = [
      (g) => {
        const i = g.getIndex()!,
          a = i.getX(0);
        i.setX(0, i.getX(1));
        i.setX(1, a);
      },
      (g) => {
        g.getIndex()!.setX(0, 8);
      },
      (g) => {
        g.getIndex()!.setX(0, 60000);
      },
      (g) => {
        const i = g.getIndex()!;
        i.setX(1, i.getX(0));
      },
      (g) => {
        g.getAttribute("position").setY(10, NaN);
      },
      (g) => {
        g.getAttribute("position").setX(10, -2);
      },
      (g) => {
        g.getAttribute("position").setX(1, 0.01);
      },
      // Replace equal-area faces: total area alone cannot detect this overlap
      // and matching hole. Oriented edge incidence must reject it.
      (g) => {
        const i = g.getIndex()!;
        for (let k = 0; k < 3; k++) i.setX(3 + k, i.getX(k));
      },
    ];
    for (const change of cases) {
      const { geometry } = refinedGeometry();
      try {
        change(geometry);
        expect(
          () => new RetainedTerrainSurface(1, "invalid", 0, 0, 2, 3, geometry),
        ).toThrow(/Invalid|mismatch|regular/);
      } finally {
        geometry.dispose();
      }
    }
  });

  it("rejects cross-cell T-junctions even when both cells independently cover their exact rectangles", () => {
    const { geometry, topology } = refinedGeometry(2, false);
    try {
      const original = Array.from(geometry.getIndex()!.array),
        replacement: number[] = [];
      const boundary = [1, 4, 5, 2];
      for (let i = 0; i < boundary.length; i++)
        replacement.push(11, boundary[i], boundary[(i + 1) % boundary.length]);
      geometry.setIndex([
        ...original.slice(0, 15),
        ...replacement,
        ...original.slice(30),
      ]);
      geometry.userData.terrainCellTopology = Object.freeze({
        ...topology,
        cellIndexOffsets: Object.freeze([0, 15, 27, 33, 39]),
      });
      expect(
        () => new RetainedTerrainSurface(1, "crack", 0, 0, 2, 3, geometry),
      ).toThrow("indexed cell coverage");
    } finally {
      geometry.dispose();
    }
  });

  it("invalidates metadata and attribute replacement in O(1), respecting Three version ownership", () => {
    let getters = 0;
    const changes: ((
      g: THREE.BufferGeometry,
      t: TerrainCellTopology,
    ) => void)[] = [
      (g, t) => {
        g.userData.terrainCellTopology = Object.freeze({ ...t });
      },
      (g) => {
        delete g.userData.terrainCellTopology;
      },
      (g, t) => {
        Object.defineProperty(g.userData, "terrainCellTopology", {
          get: () => {
            getters++;
            return t;
          },
        });
      },
      (g) => {
        g.getAttribute("position").needsUpdate = true;
      },
      (g) => {
        g.getIndex()!.needsUpdate = true;
      },
      (g) => {
        const p = g.getAttribute("position");
        g.setAttribute("position", new THREE.BufferAttribute(p.array, 3));
      },
      (g) => {
        const i = g.getIndex()!;
        i.array = i.array.slice();
      },
      (g) => {
        g.getIndex()!.normalized = true;
      },
    ];
    for (const change of changes) {
      const { geometry, topology } = refinedGeometry();
      try {
        const surface = new RetainedTerrainSurface(
          1,
          "lifetime",
          0,
          0,
          2,
          3,
          geometry,
        );
        expect(surface.matchesGeometry(geometry)).toBe(true);
        expect(Reflect.set(topology.cellIndexOffsets, "1", 12)).toBe(false);
        expect(topology.cellIndexOffsets[1]).toBe(15);
        change(geometry, topology);
        expect(surface.matchesGeometry(geometry)).toBe(false);
      } finally {
        geometry.dispose();
      }
    }
    expect(getters).toBe(0);
    const geometry = gridGeometry(2, 3, () => 20);
    try {
      const surface = new RetainedTerrainSurface(
        1,
        "legacy",
        0,
        0,
        2,
        3,
        geometry,
      );
      geometry.userData.terrainCellTopology = undefined;
      expect(surface.matchesGeometry(geometry)).toBe(false);
    } finally {
      geometry.dispose();
    }
  });
});

describe("retained Float32 terrain triangle contact", () => {
  it.each([false, true])(
    "reads only canonical cells using actual face offsets before and after refinements (indexed=%s)",
    (indexed) => {
      const fixture = indexed ? isolatedRefinedGeometry() : null,
        geometry =
          fixture?.geometry ?? gridGeometry(3, 4, (x, z) => 20 + x * z);
      try {
        const surface = new RetainedTerrainSurface(
            1,
            "canonical-cell",
            350,
            250,
            3,
            4,
            geometry,
          ),
          p = geometry.getAttribute("position"),
          originalPositions = p.array.slice(),
          originalIndices = geometry.getIndex()!.array.slice(),
          triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          out: TerrainGridTriangle = [91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
        if (fixture) {
          expect(fixture.topology.cellIndexOffsets[3] / 3).toBe(6);
          expect(fixture.topology.cellIndexOffsets[5] / 3).toBe(12);
        }
        for (let cell = 0; cell < 9; cell++) {
          const a = Math.floor(cell / 3) * 4 + (cell % 3),
            bounds = {
              minX: p.getX(a) + 0.25,
              maxX: p.getX(a + 1) - 0.25,
              minZ: p.getZ(a) + 0.25,
              maxZ: p.getZ(a + 4) - 0.25,
            },
            cursor = surface.createTriangleCursor(bounds),
            firstFace = fixture
              ? fixture.topology.cellIndexOffsets[cell] / 3
              : cell * 2;
          let visited = 0;
          while (cursor.next(triangle)) {
            expect(triangle[9]).toBe(firstFace + visited++);
            const before = [...out],
              canonical = !indexed || cell !== 4;
            expect(
              surface.readCanonicalTriangleInBounds(triangle[9], bounds, out),
            ).toBe(canonical);
            expect(out).toEqual(canonical ? triangle : before);
          }
          expect(visited).toBe(indexed && cell === 4 ? 4 : 2);
        }
        expect(p.array).toEqual(originalPositions);
        expect(geometry.getIndex()!.array).toEqual(originalIndices);
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
      }
    },
  );

  it("excludes exact and outward Float32 cell boundaries beside a one-ULP skinny refined neighbour", () => {
    const { geometry } = isolatedRefinedGeometry(),
      bits = new DataView(new ArrayBuffer(4)),
      nextFloat32 = (value: number, upward: boolean) => {
        bits.setFloat32(0, value);
        bits.setUint32(0, bits.getUint32(0) + (value > 0 === upward ? 1 : -1));
        return bits.getFloat32(0);
      };
    const position = geometry.getAttribute("position");
    position.setX(16, nextFloat32(-0.5, true));
    position.needsUpdate = true;
    try {
      const surface = new RetainedTerrainSurface(
          1,
          "skinny-neighbour",
          350,
          250,
          3,
          4,
          geometry,
        ),
        base = { minX: -1.25, maxX: -0.75, minZ: -0.25, maxZ: 0.25 },
        out: TerrainGridTriangle = [91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
      expect(position.getX(16)).toBeGreaterThan(-0.5);
      expect(surface.readCanonicalTriangleInBounds(6, base, out)).toBe(true);
      const before = [...out];
      for (const [field, edge, inwardUp] of [
        ["minX", -1.5, true],
        ["maxX", -0.5, false],
        ["minZ", -0.5, true],
        ["maxZ", 0.5, false],
      ] as const) {
        for (const value of [edge, nextFloat32(edge, !inwardUp)]) {
          const bounds = { ...base, [field]: value };
          expect(surface.readCanonicalTriangleInBounds(6, bounds, out)).toBe(
            false,
          );
          expect(out).toEqual(before);
          if (field === "maxX") {
            const cursor = surface.createTriangleCursor(bounds),
              triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
              faces: number[] = [];
            while (cursor.next(triangle)) faces.push(triangle[9]);
            expect(faces).toEqual([6, 7, 8, 9, 10, 11]);
          }
        }
        const inside = { ...base, [field]: nextFloat32(edge, inwardUp) },
          cursor = surface.createTriangleCursor(inside),
          triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        expect(surface.readCanonicalTriangleInBounds(6, inside, out)).toBe(
          true,
        );
        expect(out).toEqual(before);
        expect(cursor.next(triangle)).toBe(true);
        expect(triangle[9]).toBe(6);
        expect(cursor.next(triangle)).toBe(true);
        expect(triangle[9]).toBe(7);
        expect(cursor.next(triangle)).toBe(false);
      }
      expect(surface.matchesGeometry(geometry)).toBe(true);
    } finally {
      geometry.dispose();
    }
  });

  it("preserves the cursor's nominal-domain rejection in outward-rounded Float32 edge slivers", () => {
    const size = 0.2,
      half = size / 2,
      geometry = gridGeometry(size, 3, () => 20);
    try {
      const surface = new RetainedTerrainSurface(
          1,
          "float32-domain-sliver",
          0,
          0,
          size,
          3,
          geometry,
        ),
        edge = geometry.getAttribute("position").getX(2),
        sliver = (half + edge) / 2,
        out: TerrainGridTriangle = [91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
      expect(sliver).toBeGreaterThan(half);
      expect(sliver).toBeLessThan(edge);
      for (const [axis, sign, face] of [
        ["x", 1, 6],
        ["x", -1, 4],
        ["z", 1, 6],
        ["z", -1, 2],
      ] as const) {
        const x = axis === "x" ? sign * sliver : 0.05,
          z = axis === "z" ? sign * sliver : 0.05,
          bounds = { minX: x, maxX: x, minZ: z, maxZ: z };
        expect(surface.readTriangle(face, out)).toBe(true);
        const before = [...out];
        expect(surface.createTriangleCursor(bounds).hasNext()).toBe(false);
        expect(surface.readCanonicalTriangleInBounds(face, bounds, out)).toBe(
          false,
        );
        expect(out).toEqual(before);
        const inside =
          axis === "x"
            ? { ...bounds, minX: sign * half, maxX: sign * half }
            : { ...bounds, minZ: sign * half, maxZ: sign * half };
        expect(surface.createTriangleCursor(inside).hasNext()).toBe(true);
        expect(surface.readCanonicalTriangleInBounds(face, inside, out)).toBe(
          true,
        );
        expect(out).toEqual(before);
      }
    } finally {
      geometry.dispose();
    }
  });

  it.each([
    { label: "reversed face order", indices: [1, 3, 4, 0, 3, 1] },
    { label: "rotated vertex order", indices: [3, 1, 0, 3, 4, 1] },
    { label: "alternate diagonal", indices: [0, 3, 4, 0, 4, 1] },
  ])(
    "rejects an admitted noncanonical two-face cell: $label",
    ({ indices }) => {
      const geometry = gridGeometry(2, 3, (x, z) => 20 + x * z);
      geometry.setIndex([...indices, ...geometry.getIndex()!.array.slice(6)]);
      geometry.userData.terrainCellTopology = Object.freeze({
        schemaVersion: 1,
        resolution: 3,
        cellIndexOffsets: Object.freeze([0, 6, 12, 18, 24]),
        surfaceVertexCount: 9,
      } satisfies TerrainCellTopology);
      try {
        const surface = new RetainedTerrainSurface(
            1,
            "noncanonical-cell",
            0,
            0,
            2,
            3,
            geometry,
          ),
          bounds = { minX: -0.75, maxX: -0.25, minZ: -0.75, maxZ: -0.25 },
          out: TerrainGridTriangle = [91, 92, 93, 94, 95, 96, 97, 98, 99, 100],
          expected: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          cursor = surface.createTriangleCursor(bounds),
          before = [...out];
        for (const face of [0, 1]) {
          expect(surface.readCanonicalTriangleInBounds(face, bounds, out)).toBe(
            false,
          );
          expect(out).toEqual(before);
          expect(surface.readTriangle(face, expected)).toBe(true);
          const actual: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          expect(cursor.next(actual)).toBe(true);
          expect(actual).toEqual(expected);
        }
        expect(cursor.next(expected)).toBe(false);
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
      }
    },
  );

  it("classifies only wholly canonical owners as regular, excluding even all-regular indexed topology", () => {
    const canonical = gridGeometry(2, 3, (x, z) => 20 + x * z),
      indexed = gridGeometry(2, 3, (x, z) => 20 + x * z),
      refined = refinedGeometry().geometry;
    indexed.userData.terrainCellTopology = Object.freeze({
      schemaVersion: 1,
      resolution: 3,
      cellIndexOffsets: Object.freeze([0, 6, 12, 18, 24]),
      surfaceVertexCount: 9,
    } satisfies TerrainCellTopology);
    try {
      for (const geometry of [canonical, indexed, refined]) {
        const surface = new RetainedTerrainSurface(
          1,
          "regular-classification",
          0,
          0,
          2,
          3,
          geometry,
        );
        expect(surface.isRegularGrid).toBe(geometry === canonical);
        expect(
          Reflect.set(surface, "isRegularGrid", geometry !== canonical),
        ).toBe(false);
        expect(surface.isRegularGrid).toBe(geometry === canonical);
        expect(surface.matchesGeometry(geometry)).toBe(true);
      }
    } finally {
      canonical.dispose();
      indexed.dispose();
      refined.dispose();
    }
  });

  it.each([
    { refined: false, resolution: 2, size: 100 },
    { refined: false, resolution: 3, size: 0.03125 },
    { refined: false, resolution: 16, size: 100 },
    { refined: false, resolution: 64, size: 100 },
    { refined: true, resolution: 3, size: 2 },
    { refined: true, resolution: 3, size: 100 },
  ])(
    "reads every admitted face without traversal state: $refined / $resolution / $size",
    ({ refined, resolution, size }) => {
      const geometry = refined
        ? refinedGeometry(size).geometry
        : gridGeometry(
            size,
            resolution,
            (x, z) => 20 + Math.sin(x) + Math.cos(z),
          );
      try {
        const surface = new RetainedTerrainSurface(
            1,
            "face-reader",
            350,
            250,
            size,
            resolution,
            geometry,
          ),
          bounds = {
            minX: -size / 2,
            maxX: size / 2,
            minZ: -size / 2,
            maxZ: size / 2,
          },
          cursor = surface.createTriangleCursor(bounds),
          independent = surface.createTriangleCursor(bounds),
          expected: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          actual: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          position = geometry.getAttribute("position"),
          index = geometry.getIndex()!,
          beforePositions = position.array.slice(),
          beforeIndices = index.array.slice(),
          faces: TerrainGridTriangle[] = [];
        expect(surface.isRegularGrid).toBe(!refined);
        while (cursor.next(expected)) {
          expect(surface.readTriangle(expected[9], actual)).toBe(true);
          expect(actual).toEqual(expected);
          for (let corner = 0; corner < 3; corner++) {
            const vertex = index.getX(expected[9] * 3 + corner);
            expect(actual[corner * 3]).toBe(position.getX(vertex));
            expect(actual[corner * 3 + 1]).toBe(position.getY(vertex));
            expect(actual[corner * 3 + 2]).toBe(position.getZ(vertex));
          }
          faces.push([...expected]);
        }
        expect(faces.length).toBe(refined ? 14 : 2 * (resolution - 1) ** 2);
        // Reverse and repeat reads cannot advance a cursor or alter another output.
        for (let face = faces.length - 1; face >= 0; face--) {
          expect(surface.readTriangle(face, actual)).toBe(true);
          expect(actual).toEqual(faces[face]);
          expect(independent.next(expected)).toBe(true);
          expect(expected).toEqual(faces[faces.length - face - 1]);
        }
        expect(surface.readTriangle(0, actual)).toBe(true);
        expect(actual).toEqual(faces[0]);
        expect(independent.next(expected)).toBe(false);
        expect(position.array).toEqual(beforePositions);
        expect(index.array).toEqual(beforeIndices);
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
      }
    },
  );

  it.each([false, true])(
    "rejects invalid face indices and every appended skirt without touching output (refined=%s)",
    (refined) => {
      const geometry = refined
        ? refinedGeometry().geometry
        : gridGeometry(2, 3, () => 20);
      if (!refined) {
        const positions = Array.from(geometry.getAttribute("position").array);
        positions.push(-1, 15, -1, 0, 15, -1);
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(positions), 3),
        );
        geometry.setIndex([...geometry.getIndex()!.array, 0, 9, 1, 1, 9, 10]);
      }
      try {
        const surface = new RetainedTerrainSurface(
            1,
            "face-bounds",
            350,
            250,
            2,
            3,
            geometry,
          ),
          faceCount = refined ? 14 : 8,
          canonicalBounds = { minX: 0.25, maxX: 0.75, minZ: 0.25, maxZ: 0.75 },
          out: TerrainGridTriangle = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
        expect(surface.readTriangle(0, out)).toBe(true);
        expect(out[9]).toBe(0);
        expect(surface.readTriangle(faceCount - 1, out)).toBe(true);
        expect(out[9]).toBe(faceCount - 1);
        const before = [...out];
        for (const face of [
          -1,
          -0.5,
          0.5,
          NaN,
          -Infinity,
          Infinity,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER + 1,
          faceCount,
          faceCount + 1,
          faceCount + 2,
        ]) {
          expect(surface.readTriangle(face, out)).toBe(false);
          expect(out).toEqual(before);
          expect(
            surface.readCanonicalTriangleInBounds(face, canonicalBounds, out),
          ).toBe(false);
          expect(out).toEqual(before);
        }
        for (const bounds of [
          { ...canonicalBounds, minX: NaN },
          { ...canonicalBounds, maxX: Infinity },
          { ...canonicalBounds, minZ: -Infinity },
          { ...canonicalBounds, maxZ: NaN },
          { ...canonicalBounds, minX: 0.8 },
          { ...canonicalBounds, minZ: 0.8 },
          { ...canonicalBounds, minX: -0.75, maxX: -0.25 },
        ]) {
          expect(
            surface.readCanonicalTriangleInBounds(faceCount - 1, bounds, out),
          ).toBe(false);
          expect(out).toEqual(before);
        }
        expect(geometry.getIndex()!.count / 3).toBe(faceCount + 2);
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
      }
    },
  );

  it.each([false, true])(
    "rejects held attribute revisions while leaving replacement ownership to the existing lease (refined=%s)",
    (refined) => {
      const heldChanges: ((geometry: THREE.BufferGeometry) => void)[] = [
        (g) => {
          g.getAttribute("position").needsUpdate = true;
        },
        (g) => {
          g.getIndex()!.needsUpdate = true;
        },
        (g) => {
          const p = g.getAttribute("position");
          if (!(p instanceof THREE.BufferAttribute))
            throw new Error(
              "Expected the actual noninterleaved grid position attribute",
            );
          p.array = p.array.slice();
        },
        (g) => {
          const i = g.getIndex()!;
          i.array = i.array.slice();
        },
        (g) => {
          g.getAttribute("position").itemSize = 2;
        },
      ];
      for (const change of heldChanges) {
        const geometry = refined
          ? refinedGeometry().geometry
          : gridGeometry(2, 3, () => 20);
        try {
          const surface = new RetainedTerrainSurface(
              1,
              "held-revision",
              0,
              0,
              2,
              3,
              geometry,
            ),
            canonicalFace = refined ? 12 : 6,
            bounds = { minX: 0.25, maxX: 0.75, minZ: 0.25, maxZ: 0.75 },
            out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          expect(surface.readTriangle(0, out)).toBe(true);
          expect(
            surface.readCanonicalTriangleInBounds(canonicalFace, bounds, out),
          ).toBe(true);
          const before = [...out];
          change(geometry);
          expect(surface.matchesGeometry(geometry)).toBe(false);
          expect(surface.readTriangle(0, out)).toBe(false);
          expect(out).toEqual(before);
          expect(
            surface.readCanonicalTriangleInBounds(canonicalFace, bounds, out),
          ).toBe(false);
          expect(out).toEqual(before);
        } finally {
          geometry.dispose();
        }
      }
      const replacements: ((geometry: THREE.BufferGeometry) => void)[] = [
        (g) => {
          const p = g.getAttribute("position");
          g.setAttribute("position", new THREE.BufferAttribute(p.array, 3));
        },
        (g) => {
          const i = g.getIndex()!;
          g.setIndex(new THREE.BufferAttribute(i.array, 1));
        },
        (g) => {
          g.userData.terrainCellTopology = refined
            ? Object.freeze({ ...g.userData.terrainCellTopology })
            : undefined;
        },
      ];
      for (const replace of replacements) {
        const geometry = refined
          ? refinedGeometry().geometry
          : gridGeometry(2, 3, () => 20);
        try {
          const surface = new RetainedTerrainSurface(
              1,
              "replacement-lease",
              0,
              0,
              2,
              3,
              geometry,
            ),
            out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          expect(surface.readTriangle(0, out)).toBe(true);
          expect(
            surface.readCanonicalTriangleInBounds(
              refined ? 12 : 6,
              { minX: 0.25, maxX: 0.75, minZ: 0.25, maxZ: 0.75 },
              out,
            ),
          ).toBe(true);
          replace(geometry);
          // The stateless reader does not retain the geometry. As with sample
          // and cursors, replacement/topology changes invalidate the caller's
          // matchesGeometry/region lease; no direct-read detection is claimed.
          expect(surface.matchesGeometry(geometry)).toBe(false);
        } finally {
          geometry.dispose();
        }
      }
    },
  );

  it.each([
    [2, 100],
    [16, 100],
    [64, 100],
    [256, 0.03125],
  ])(
    "resumes allocation-free original triangle traversal at every Float32 boundary r=%s size=%s",
    (resolution, size) => {
      const geometry = gridGeometry(
        size,
        resolution,
        (x, z) => 20 + Math.sin(x) + Math.cos(z),
      );
      const surface = new RetainedTerrainSurface(
        1,
        "cursor",
        350,
        250,
        size,
        resolution,
        geometry,
      );
      const p = geometry.getAttribute("position"),
        index = geometry.getIndex()!;
      try {
        const half = size / 2,
          m = Math.floor(resolution / 2);
        const x = p.getX(m),
          z = p.getZ(m * resolution);
        const boxes: TerrainGridBounds[] = [
          { minX: -half, maxX: half, minZ: -half, maxZ: half },
          { minX: x, maxX: x, minZ: z, maxZ: z },
          {
            minX: x - size * 1e-9,
            maxX: x - size * 1e-9,
            minZ: -half,
            maxZ: half,
          },
          {
            minX: x + size * 1e-9,
            maxX: x + size * 1e-9,
            minZ: -half,
            maxZ: half,
          },
          { minX: -half, maxX: -half, minZ: -half, maxZ: -half },
          { minX: half, maxX: half, minZ: half, maxZ: half },
          { minX: -size, maxX: size, minZ: -size, maxZ: size },
          { minX: -size, maxX: -half - size / 100, minZ: -half, maxZ: half },
        ];
        for (const bounds of boxes) {
          const expected: TerrainGridTriangle[] = [];
          const receipt = surface.visitTrianglesInBounds(
            bounds,
            (...triangle) => expected.push(triangle),
            1_000_000,
          );
          expect(receipt.exhausted).toBe(false);
          const cursor = surface.createTriangleCursor(bounds),
            out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          let count = 0;
          while (cursor.next(out)) {
            expect(out).toEqual(expected[count++]);
            for (let corner = 0; corner < 3; corner++) {
              const vertex = index.getX(out[9] * 3 + corner);
              expect(out[corner * 3]).toBe(p.getX(vertex));
              expect(out[corner * 3 + 1]).toBe(p.getY(vertex));
              expect(out[corner * 3 + 2]).toBe(p.getZ(vertex));
            }
          }
          expect(count).toBe(receipt.visited);
          const last = [...out];
          expect(cursor.next(out)).toBe(false);
          expect(out).toEqual(last);
        }
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
      }
    },
  );

  it("keeps independent paused cursors and rejects invalid bounds without modifying output/geometry", () => {
    const geometry = gridGeometry(100, 16, () => 20);
    const surface = new RetainedTerrainSurface(
      1,
      "cursor",
      0,
      0,
      100,
      16,
      geometry,
    );
    try {
      const bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
      const a = surface.createTriangleCursor(bounds),
        b = surface.createTriangleCursor(bounds);
      const out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        before = geometry.getAttribute("position").array.slice();
      for (let face = 0; face < 27; face++) {
        expect(a.next(out)).toBe(true);
        expect(out[9]).toBe(face);
      }
      expect(b.next(out)).toBe(true);
      expect(out[9]).toBe(0);
      expect(a.next(out)).toBe(true);
      expect(out[9]).toBe(27);
      expect(geometry.getAttribute("position").array).toEqual(before);
      for (const invalid of [
        { ...bounds, minX: NaN },
        { ...bounds, minZ: Infinity },
        { ...bounds, minX: 51 },
      ])
        expect(() => surface.createTriangleCursor(invalid)).toThrow(
          "Invalid retained",
        );
    } finally {
      geometry.dispose();
    }
  });

  it.each([4, 16, 64])(
    "matches real mesh ray hits across both triangle halves, vertices and boundaries at resolution %s",
    (resolution) => {
      const geometry = gridGeometry(
        100,
        resolution,
        (x, z) => 25 + Math.sin(x * 0.17) + Math.cos(z * 0.11) + x * z * 0.002,
      );
      const surface = new RetainedTerrainSurface(
        1,
        "fixture",
        450,
        450,
        100,
        resolution,
        geometry,
      );
      const material = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      const ray = new THREE.Raycaster();
      const out = sample();
      let tested = 0;
      try {
        const step = Math.max(1, Math.floor(resolution / 8));
        for (let z = 0; z < resolution - 1; z += step)
          for (let x = 0; x < resolution - 1; x += step) {
            const p = geometry.getAttribute("position");
            const a = z * resolution + x;
            for (const [u, v] of [
              [0.1, 0.2],
              [0.8, 0.7],
              [0, 0],
              [1, 1],
            ]) {
              const lx = p.getX(a) + (p.getX(a + 1) - p.getX(a)) * u;
              const lz = p.getZ(a) + (p.getZ(a + resolution) - p.getZ(a)) * v;
              expect(surface.sample(lx, lz, out)).toBe(true);
              ray.set(
                new THREE.Vector3(lx, 100, lz),
                new THREE.Vector3(0, -1, 0),
              );
              const hits = ray.intersectObject(mesh);
              expect(hits.length).toBeGreaterThan(0);
              expect(out.height).toBeCloseTo(hits[0].point.y, 10);
              if (u !== v) {
                expect(out.faceIndex).toBe(hits[0].faceIndex);
                expect(out.nx).toBeCloseTo(hits[0].face!.normal.x, 10);
                expect(out.ny).toBeCloseTo(hits[0].face!.normal.y, 10);
                expect(out.nz).toBeCloseTo(hits[0].face!.normal.z, 10);
              }
              tested++;
            }
          }
        expect(tested).toBe(4 * Math.ceil((resolution - 1) / step) ** 2);
        expect(surface.sample(50.01, 0, out)).toBe(false);
        expect(surface.sample(NaN, 0, out)).toBe(false);
      } finally {
        geometry.dispose();
        material.dispose();
      }
    },
  );

  it("reproduces archived compact-v1 probe08 face20 and corrects its 74.249mm gap", () => {
    // Retained probe08 triangle data, deliberately independent of the evolving
    // compact-v2 manifest. These are actual rendered Float32 vertex heights.
    const geometry = gridGeometry(100, 16, () => 22);
    const p = geometry.getAttribute("position");
    p.setY(10, 22.144079208374023);
    p.setY(11, 22.140716552734375);
    p.setY(26, 22.243621826171875);
    const surface = new RetainedTerrainSurface(
      60,
      "archived-compact-v1-probe08",
      450,
      450,
      100,
      16,
      geometry,
    );
    const original: GrassAnchorData = {
      count: 1,
      offsets: new Float32Array([
        22.07981300354004, 22.232837677001953, -48.845394134521484,
      ]),
      rotScaleHash: new Float32Array([1, 1, 0.5]),
      groundColors: new Float32Array([0.1, 0.2, 0.3]),
      grassTints: new Float32Array([1, 1, 1, 0.5]),
      groundNormals: new Float32Array([
        0.04902935028076172, 0.9976301789283752, -0.04827174171805382,
      ]),
    };
    try {
      const out = sample();
      expect(
        surface.sample(original.offsets[0], original.offsets[2], out),
      ).toBe(true);
      expect(out.faceIndex).toBe(20);
      expect(out.height).toBeCloseTo(22.158588696783227, 10);
      expect(original.offsets[1] - out.height).toBeCloseTo(
        0.0742489802187265,
        10,
      );
      const projected = projectGrassAnchors(
        original,
        surface,
        () => 16,
        () => false,
      );
      expect(Math.abs(projected.offsets[1] - out.height)).toBeLessThan(1e-6);
      expect(projected.grounding.computedHeights[0]).toBe(original.offsets[1]);
      expect(projected.grounding.ecologicalNormals).toEqual(
        original.groundNormals,
      );
      expect(projected.groundNormals).not.toEqual(original.groundNormals);
      expect(original.offsets[1]).toBe(22.232837677001953);
    } finally {
      geometry.dispose();
    }
  });

  it("rechecks elevated water and exclusions on projected anchors and compacts every attribute without changing inputs", () => {
    const geometry = gridGeometry(8, 4, (x) => 25 + x);
    const surface = new RetainedTerrainSurface(
      1,
      "fixture",
      350,
      320,
      8,
      4,
      geometry,
    );
    const data: GrassAnchorData = {
      count: 4,
      offsets: new Float32Array([-3, 30, 0, -1, 30, 0, 1, 30, 0, 3, 30, 0]),
      rotScaleHash: Float32Array.from({ length: 12 }, (_, i) => i),
      groundColors: Float32Array.from({ length: 12 }, (_, i) => i + 20),
      grassTints: Float32Array.from({ length: 16 }, (_, i) => i + 40),
      groundNormals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    };
    const before = structuredClone(data);
    try {
      const result = projectGrassAnchors(
        data,
        surface,
        () => 24,
        (x) => x === 353,
      );
      expect(result.count).toBe(1);
      expect(Array.from(result.offsets)).toEqual([1, 26, 0]);
      expect(result.rotScaleHash).toEqual(data.rotScaleHash.slice(6, 9));
      expect(result.groundColors).toEqual(data.groundColors.slice(6, 9));
      expect(result.grassTints).toEqual(data.grassTints.slice(8, 12));
      expect(result.groundNormals.length).toBe(3);
      expect(result.grounding.computedHeights).toEqual(new Float32Array([30]));
      expect(data).toEqual(before);
      expect(
        projectGrassAnchors(
          data,
          surface,
          () => 31,
          () => false,
        ).count,
      ).toBe(0);
    } finally {
      geometry.dispose();
    }
  });
});

describe("retained grounding edge block traversal", () => {
  type Edge = readonly [number, number, number, number];
  // Independently frozen legacy edge clip equations. The spatial cursor does
  // not supply this oracle, and no new epsilon or snapping enters the result.
  const clip = (t: TerrainGridTriangle, edge: Edge, ox: number, oz: number) => {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t,
      [aX, aZ, bX, bZ] = edge,
      dx = bX - aX,
      dz = bZ - aZ,
      determinant = (bx - ax) * (cz - az) - (bz - az) * (cx - ax),
      u0 =
        ((aX - ox - ax) * (cz - az) - (aZ - oz - az) * (cx - ax)) / determinant,
      v0 =
        ((bx - ax) * (aZ - oz - az) - (bz - az) * (aX - ox - ax)) / determinant,
      du = (dx * (cz - az) - dz * (cx - ax)) / determinant,
      dv = ((bx - ax) * dz - (bz - az) * dx) / determinant;
    let lo = 0,
      hi = 1;
    for (let e = 0; e < 3; e++) {
      const start = e === 0 ? u0 : e === 1 ? v0 : 1 - u0 - v0,
        change = e === 0 ? du : e === 1 ? dv : -du - dv;
      if (Math.abs(change) < 1e-14) {
        if (start < -1e-10) {
          lo = 1;
          hi = 0;
          break;
        }
      } else if (change > 0) lo = Math.max(lo, -start / change);
      else hi = Math.min(hi, -start / change);
    }
    if (lo > hi + 1e-10 || hi < 0 || lo > 1) return null;
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
    return [
      t[9],
      lo,
      hi,
      ay + (u0 + du * lo) * (by - ay) + (v0 + dv * lo) * (cy - ay),
      ay + (u0 + du * hi) * (by - ay) + (v0 + dv * hi) * (cy - ay),
    ];
  };
  const collect = (surface: RetainedTerrainSurface, edge: Edge) => {
    const generic = surface.createTriangleCursor({
        minX: Math.min(edge[0], edge[2]) - surface.centerX,
        maxX: Math.max(edge[0], edge[2]) - surface.centerX,
        minZ: Math.min(edge[1], edge[3]) - surface.centerZ,
        maxZ: Math.max(edge[1], edge[3]) - surface.centerZ,
      }),
      indexed = surface.createGroundingEdgeCursor(...edge),
      triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      allFaces: number[] = [],
      candidates: number[] = [],
      expected: number[][] = [],
      actual: number[][] = [];
    let blocks = 0;
    expect(indexed).not.toBeNull();
    while (generic.next(triangle)) {
      allFaces.push(triangle[9]);
      const result = clip(triangle, edge, surface.centerX, surface.centerZ);
      if (result) expected.push(result);
    }
    for (;;) {
      const step = indexed!.step(triangle);
      if (!step) break;
      if (step === "block") {
        blocks++;
        continue;
      }
      candidates.push(triangle[9]);
      const result = clip(triangle, edge, surface.centerX, surface.centerZ);
      if (result) actual.push(result);
    }
    expect(actual).toEqual(expected);
    expect(candidates).toEqual(
      allFaces.filter((face) => candidates.includes(face)),
    );
    return { allFaces, candidates, blocks, actual };
  };

  it.each([false, true])(
    "preserves exact legacy clipping, order and height for dyadic and skinny blocks (skinny=%s)",
    (skinny) => {
      const geometry = denseEdgeGeometry(skinny);
      try {
        for (const center of [0, 350, 2 ** 20 - 2, -(2 ** 20) + 2]) {
          const surface = new RetainedTerrainSurface(
            1,
            "edge-blocks",
            center,
            center,
            2,
            3,
            geometry,
          );
          const edges: Edge[] = [
            [-0.92, -0.88, -0.84, -0.82],
            [-1, -1, 1, 1],
            [1, -1, -1, 1],
            [0, 0, 0, 0],
            [-1, -1, -1, -1],
            [1, 1, 1, 1],
            [-0.9, 0, 0.9, 0],
            [0, -0.9, 0, 0.9],
            [-0.5, -0.5, -0.25, -0.25],
            [-1 + 2 ** -24, -0.7, -1 + 2 ** -24, -0.6],
            [1.01, 0, 1.02, 0],
          ];
          for (const epsilon of [
            -2e-10, -1e-10, -1e-14, 0, 1e-14, 1e-10, 2e-10,
          ]) {
            edges.push([-0.8, -0.5 + epsilon, -0.3, -0.5 + epsilon]);
            edges.push([-0.75 - epsilon, -0.75, -0.5, -0.5 - epsilon]);
            edges.push([-0.5, -0.5, -0.5 + epsilon, -0.5 - epsilon]);
          }
          // Deterministic endpoints span all four original cells and many
          // subcell boundaries; nonplanar y values expose face substitution.
          for (let i = 0; i < 96; i++) {
            const x = ((i * 37) % 191) / 100 - 0.95,
              z = ((i * 61) % 191) / 100 - 0.95;
            edges.push([x, z, Math.min(1, x + 0.07), Math.max(-1, z - 0.13)]);
          }
          for (const edge of edges)
            collect(
              surface,
              edge.map((value) => value + center) as unknown as Edge,
            );
          const small = collect(
            surface,
            [-0.92, -0.88, -0.84, -0.82].map(
              (value) => value + center,
            ) as unknown as Edge,
          );
          if (!skinny) {
            expect(small.candidates.length + small.blocks).toBeLessThan(
              small.allFaces.length,
            );
            expect(small.candidates.length).toBe(8);
            expect(small.blocks).toBe(4);
          }
        }
      } finally {
        geometry.dispose();
      }
    },
  );

  it("accounts bounded admission metadata and leaves generic traversal unchanged", () => {
    const geometry = denseEdgeGeometry();
    try {
      const { surface, phases } = finishPreparation(
        RetainedTerrainSurface.prepare(1, "blocks", 0, 0, 2, 3, geometry),
      );
      expect(surface.groundingEdgeIndexStats).toEqual({
        blocks: 16,
        qualifiedBlocks: 16,
        bytes: 16 * 4 * 8 + 5 * 4,
        admissionSteps: 18,
      });
      expect(
        phases.filter((phase) => phase.startsWith("grounding-edge-index-"))
          .length,
      ).toBe(18);
      const result = collect(surface, [-1, -1, 1, 1]);
      expect(result.allFaces).toEqual(
        Array.from({ length: 128 }, (_, index) => index),
      );
      expect(surface.matchesGeometry(geometry)).toBe(true);
    } finally {
      geometry.dispose();
    }
  });

  it("retains the legacy accepted inverted clip interval at a just-missed vertex", () => {
    const geometry = denseEdgeGeometry();
    try {
      const surface = new RetainedTerrainSurface(
          1,
          "inverted-interval",
          0,
          0,
          2,
          3,
          geometry,
        ),
        result = collect(surface, [-0.8, -1.05 - 1e-12, -0.7, -0.95 - 1e-12]),
        inverted = result.actual.filter((row) => row[1] > row[2]);
      expect(inverted.length).toBeGreaterThan(0);
      for (const row of inverted)
        expect(row[1] - row[2]).toBeLessThanOrEqual(1e-10);
      expect(result.candidates.length).toBeLessThan(result.allFaces.length);
    } finally {
      geometry.dispose();
    }
  });

  it("admits the exact negative determinant threshold and exhausts smaller determinants", () => {
    const geometry = denseEdgeGeometry();
    try {
      const position = geometry.getAttribute("position");
      for (let i = 0; i < position.count; i++) {
        position.setX(i, position.getX(i) / 16);
        position.setZ(i, position.getZ(i) / 16);
      }
      position.needsUpdate = true;
      const threshold = new RetainedTerrainSurface(
        1,
        "threshold",
        0,
        0,
        0.125,
        3,
        geometry,
      );
      expect(threshold.groundingEdgeIndexStats?.qualifiedBlocks).toBe(16);
      const triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      expect(threshold.readTriangle(0, triangle)).toBe(true);
      expect(
        (triangle[3] - triangle[0]) * (triangle[8] - triangle[2]) -
          (triangle[5] - triangle[2]) * (triangle[6] - triangle[0]),
      ).toBe(-(2 ** -12));
      collect(threshold, [-0.06, -0.06, -0.052, -0.053]);
      collect(threshold, [-0.0625, -0.0625, 0.0625, 0.0625]);
      for (let i = 0; i < position.count; i++) {
        position.setX(i, position.getX(i) / 2);
        position.setZ(i, position.getZ(i) / 2);
      }
      position.needsUpdate = true;
      const tiny = new RetainedTerrainSurface(
        1,
        "tiny",
        0,
        0,
        0.0625,
        3,
        geometry,
      );
      expect(tiny.groundingEdgeIndexStats?.qualifiedBlocks).toBe(0);
      expect(tiny.createGroundingEdgeCursor(0, 0, 0.01, 0.01)).toBeNull();
    } finally {
      geometry.dispose();
    }
  });

  it("falls back outside the proved coordinate/segment domain and for small cells", () => {
    const geometry = denseEdgeGeometry(),
      small = refinedGeometry();
    try {
      const surface = new RetainedTerrainSurface(
        1,
        "blocks",
        0,
        0,
        2,
        3,
        geometry,
      );
      for (const edge of [
        [0, 0, 2.01, 0],
        [0, 0, 0, 2.01],
        [65, 0, 65, 0],
        [Infinity, 0, 0, 0],
        [NaN, 0, 0, 0],
      ] as Edge[])
        expect(surface.createGroundingEdgeCursor(...edge)).toBeNull();
      const distant = new RetainedTerrainSurface(
        1,
        "distant",
        2 ** 21,
        0,
        2,
        3,
        geometry,
      );
      expect(
        distant.createGroundingEdgeCursor(2 ** 21, 0, 2 ** 21 + 0.1, 0),
      ).toBeNull();
      const smallSurface = new RetainedTerrainSurface(
        2,
        "small",
        0,
        0,
        2,
        3,
        small.geometry,
      );
      expect(smallSurface.groundingEdgeIndexStats?.blocks).toBe(0);
      expect(smallSurface.createGroundingEdgeCursor(0, 0, 0.1, 0.1)).toBeNull();
    } finally {
      geometry.dispose();
      small.geometry.dispose();
    }
  });

  it("checks the original geometry owner at admission resumes and every cursor step", () => {
    const geometry = denseEdgeGeometry();
    try {
      const iterator = RetainedTerrainSurface.prepare(
        1,
        "blocks",
        0,
        0,
        2,
        3,
        geometry,
      );
      for (;;) {
        const next = iterator.next();
        expect(next.done).toBe(false);
        if (next.value === "grounding-edge-index-block") break;
      }
      geometry.getAttribute("position").needsUpdate = true;
      expect(() => iterator.next()).toThrow("changed during admission");
      const surface = new RetainedTerrainSurface(
          1,
          "blocks",
          0,
          0,
          2,
          3,
          geometry,
        ),
        cursor = surface.createGroundingEdgeCursor(-0.9, -0.9, -0.8, -0.8)!,
        out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      expect(cursor.step(out)).toBe("block");
      geometry.getIndex()!.needsUpdate = true;
      expect(() => cursor.step(out)).toThrow("changed during admission");
      expect(surface.matchesGeometry(geometry)).toBe(false);
    } finally {
      geometry.dispose();
    }
  });
});
