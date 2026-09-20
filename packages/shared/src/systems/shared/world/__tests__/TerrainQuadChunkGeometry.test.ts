import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { TerrainSystem } from "../TerrainSystem";

import { BiomeType } from "../TerrainBiomeTypes";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
  resolveDuelArenaFloorHeight,
} from "../../../../data/arena-grading";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";
import {
  assembleQuadChunkGeometry,
  assembleQuadChunkGeometrySteps,
  generateQuadChunkDataSync,
  generateQuadChunkDataSteps,
  type FullTerrainProvider,
  type TerrainSurfaceRefinementZone,
  type TerrainSurfaceRefinementAnnulus,
} from "../TerrainQuadChunkGenerator";
import {
  createAuthoredTerrainSurfaceOperations,
  type AuthoredTerrainZone,
} from "../AuthoredTerrainSurface";
import { RetainedTerrainSurface } from "../TerrainGridSurface";

type HeightField = (x: number, z: number) => number;
type GradingField = (x: number, z: number) => number | null;

/** Analytic terrain input: production generators and real geometry run unchanged. */
class AnalyticTerrain implements FullTerrainProvider {
  readonly terrainProfileIdentity = worldTerrainProfileIdentity(
    COMPACT_WORLD_TERRAIN_PROFILE,
  );
  readonly TILE_SIZE = 100;
  readonly WATER_LEVEL_NORMALIZED = 0.32;
  readonly SHORELINE_THRESHOLD = 0.25;
  readonly SHORELINE_STRENGTH = 0.6;
  readonly MAX_HEIGHT = 50;
  heightSamples = 0;
  gradingSamples = 0;
  roadSamples = 0;
  biomeSamples = 0;

  constructor(
    private readonly height: HeightField,
    private readonly grading: GradingField = () => null,
    readonly surfaceRefinementZones?: readonly TerrainSurfaceRefinementZone[],
    readonly surfaceRefinementAnnuli?: readonly TerrainSurfaceRefinementAnnulus[],
  ) {}

  getFlatZoneHeight(x: number, z: number): number | null {
    this.gradingSamples++;
    return this.grading(x, z);
  }

  getHeightAtComputed(x: number, z: number): number {
    this.heightSamples++;
    return this.grading(x, z) ?? this.height(x, z);
  }

  calculateRoadInfluenceAtVertex(): number {
    this.roadSamples++;
    return 0;
  }

  computeBiomeWeightsAtPosition() {
    this.biomeSamples++;
    return {
      biomeWeightMap: new Map([[BiomeType.Forest, 1]]),
      totalWeight: 1,
    };
  }

  computeBiomeWeightsByPosition(): Record<string, number> {
    return { [BiomeType.Forest]: 1 };
  }

  getBiomeId(): number {
    return 0;
  }

  getBiomeColor() {
    return { r: 0.2, g: 0.4, b: 0.1 };
  }
}

const plane: HeightField = (x, z) => 22 + x * 0.75 - z * 0.25;

describe("world-anchored annular pond surface refinement", () => {
  // Real authored-height operations, real assembler and retained indexed-triangle
  // admission. These CPU geometry checks do not claim a rendered pond or FPS.
  const operations = createAuthoredTerrainSurfaceOperations();
  const pond: AuthoredTerrainZone = {
    id: "geometry-selected-pond",
    centerX: 343,
    centerZ: 302,
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
    },
  };
  const ring: TerrainSurfaceRefinementAnnulus = {
    centerX: pond.centerX,
    centerZ: pond.centerZ,
    innerRadius: 4.1,
    outerRadius: 7.9,
  };
  const canonical: HeightField = (x, z) =>
    operations.resolveRadialPondTerrainHeight(pond, x, z, () => 28.15) ?? 28.15;
  const provider = (
    annuli: readonly TerrainSurfaceRefinementAnnulus[] | undefined = [ring],
  ) => new AnalyticTerrain(canonical, () => null, undefined, annuli);
  type CellTopology = {
    surfaceVertexCount: number;
    cellIndexOffsets: readonly number[];
  };
  const sample = () => ({ height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 });
  const retained = (
    result: ReturnType<typeof assembleQuadChunkGeometry>,
    resolution: number,
    centerX = 350,
    centerZ = 350,
    size = 100,
  ) =>
    new RetainedTerrainSurface(
      1,
      provider().terrainProfileIdentity,
      centerX,
      centerZ,
      size,
      resolution,
      result.geometry,
    );
  const crossing = (height: HeightField, angle: number, level: number) => {
    const dx = Math.cos(angle),
      dz = Math.sin(angle);
    let low = 3.8,
      high = 11.1;
    expect(
      height(pond.centerX + low * dx, pond.centerZ + low * dz),
    ).toBeLessThan(level);
    expect(
      height(pond.centerX + high * dx, pond.centerZ + high * dz),
    ).toBeGreaterThan(level);
    let previous =
        height(pond.centerX + low * dx, pond.centerZ + low * dz) - level,
      crossings = 0;
    for (let i = 1; i <= 146; i++) {
      const radius = 3.8 + i * 0.05,
        current =
          height(pond.centerX + radius * dx, pond.centerZ + radius * dz) -
          level;
      if (current >= 0 !== previous >= 0) crossings++;
      previous = current;
    }
    expect(crossings).toBe(1);
    for (let i = 0; i < 36; i++) {
      const mid = (low + high) / 2;
      if (height(pond.centerX + mid * dx, pond.centerZ + mid * dz) < level)
        low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };

  it.skipIf(!DataManager.getWorldConfig()?.compactPondDocks)(
    "assembles the actual inland pond startup leaf within unchanged retained caps",
    async () => {
      await DataManager.getInstance().initialize();
      const world = new World();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      const geometries: THREE.BufferGeometry[] = [];
      try {
        await terrain.init();
        terrain["loadFlatZonesFromManifest"]();
        const zone = terrain["flatZones"].get("haven_pond_floor")!;
        expect([zone.centerX, zone.centerZ]).toEqual([410, 415]);
        const actual = terrain["buildChunkTerrainProvider"]();
        process.stdout.write(
          `Inland startup refinement ${JSON.stringify({ annuli: actual.surfaceRefinementAnnuli, floors: actual.surfaceRefinementZones, center: [450, 450], size: 100, resolution: 128 })}\n`,
        );
        const rows = [
          [450, 450],
          [350, 450],
          [450, 350],
          [350, 350],
        ].map(([x, z]) => {
          const worker = generateQuadChunkDataSync(x, z, 100, 128, actual);
          const before = worker.heightData.slice();
          const result = assembleQuadChunkGeometry(worker, actual, 3);
          geometries.push(result.geometry);
          const surface = new RetainedTerrainSurface(
            1,
            actual.terrainProfileIdentity,
            x,
            z,
            100,
            128,
            result.geometry,
          );
          expect(surface.matchesGeometry(result.geometry)).toBe(true);
          expect(worker.heightData).toEqual(before);
          const topology = result.geometry.userData
            .terrainCellTopology as CellTopology;
          expect(topology.surfaceVertexCount - 128 * 128).toBeLessThanOrEqual(
            65536,
          );
          let maxCellFaces = 0;
          for (let i = 1; i < topology.cellIndexOffsets.length; i++)
            maxCellFaces = Math.max(
              maxCellFaces,
              (topology.cellIndexOffsets[i] -
                topology.cellIndexOffsets[i - 1]) /
                3,
            );
          expect(maxCellFaces).toBeLessThanOrEqual(512);
          return {
            x,
            z,
            surface,
            geometry: result.geometry,
            topology,
            metrics: {
              x,
              z,
              vertices: result.geometry.getAttribute("position").count,
              surfaceVertices: topology.surfaceVertexCount,
              triangles: result.geometry.index!.count / 3,
              maxCellFaces,
            },
          };
        });
        const out = sample();
        let probes = 0,
          maximumError = 0,
          maximumNormalAngle = 0;
        let normalWitness: Record<string, number> = {};
        for (let degree = 0; degree < 360; degree++) {
          const angle = ((degree + 0.317) * Math.PI) / 180;
          for (let radial = 0; radial <= 470; radial++) {
            const radius = 9.45 + radial * 0.05;
            const x = 410 + radius * Math.cos(angle),
              z = 415 + radius * Math.sin(angle);
            const row = rows.find(
              (entry) =>
                Math.abs(x - entry.x) <= 50 && Math.abs(z - entry.z) <= 50,
            )!;
            expect(row.surface.sample(x - row.x, z - row.z, out)).toBe(true);
            maximumError = Math.max(
              maximumError,
              Math.abs(out.height - actual.getHeightAtComputed(x, z)),
            );
            const h = 0.03125;
            const nx =
              -(
                actual.getHeightAtComputed(x + h, z) -
                actual.getHeightAtComputed(x - h, z)
              ) /
              (2 * h);
            const nz =
              -(
                actual.getHeightAtComputed(x, z + h) -
                actual.getHeightAtComputed(x, z - h)
              ) /
              (2 * h);
            const cosine =
              (nx * out.nx + out.ny + nz * out.nz) / Math.hypot(nx, 1, nz);
            const normalAngle =
              (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
            if (normalAngle > maximumNormalAngle) {
              maximumNormalAngle = normalAngle;
              normalWitness = {
                x,
                z,
                radius,
                degree,
                faceIndex: out.faceIndex,
                height: out.height,
              };
            }
            probes++;
          }
        }
        const seams: number[] = [];
        for (const axis of ["x", "z"] as const)
          for (const tangent of [350, 450]) {
            const neighbours = [350, 450].map((across) =>
              rows.find(
                (entry) =>
                  entry[axis] === across &&
                  entry[axis === "x" ? "z" : "x"] === tangent,
              )!,
            );
            const edges = neighbours.map((row) => {
              const p = row.geometry.getAttribute("position"),
                n = row.geometry.getAttribute("normal");
              const edge = new Map<number, number[]>();
              for (let i = 0; i < row.topology.surfaceVertexCount; i++) {
                const across = axis === "x" ? p.getX(i) : p.getZ(i);
                const along = axis === "x" ? p.getZ(i) : p.getX(i);
                if (across + row[axis] === 400)
                  edge.set(along, [p.getY(i), n.getX(i), n.getY(i), n.getZ(i)]);
              }
              for (let i = row.topology.surfaceVertexCount; i < p.count; i++) {
                const across = axis === "x" ? p.getX(i) : p.getZ(i);
                const along = axis === "x" ? p.getZ(i) : p.getX(i);
                if (across + row[axis] !== 400) continue;
                const top = edge.get(along)!;
                expect(p.getY(i)).toBe(Math.fround(top[0] - 3));
                expect([n.getX(i), n.getY(i), n.getZ(i)]).toEqual(top.slice(1));
              }
              return [...edge].sort((a, b) => a[0] - b[0]);
            });
            expect(edges[0]).toEqual(edges[1]);
            seams.push(edges[0].length);
          }
        process.stdout.write(
          `Inland startup assembled ${JSON.stringify({ leaves: rows.map((row) => row.metrics), probes, maximumError, maximumNormalAngle, normalWitness, seamVertices: seams, nativeOrPerformanceAcceptance: false })}\n`,
        );
        const shoulderOnly: FullTerrainProvider = {
          ...actual,
          surfaceRefinementAnnuli: actual.surfaceRefinementAnnuli!.filter(
            (ring) => ring.bearing !== undefined,
          ),
        };
        const witnessGeometry = assembleQuadChunkGeometry(
          generateQuadChunkDataSync(450, 450, 100, 128, shoulderOnly),
          shoulderOnly,
          3,
        ).geometry;
        geometries.push(witnessGeometry);
        const witnessSurface = new RetainedTerrainSurface(
          2,
          actual.terrainProfileIdentity,
          450,
          450,
          100,
          128,
          witnessGeometry,
        );
        // Retain the exact rejected coarse-fan witness independently of the
        // current maximum. Its old shoulder lattice is an actual source
        // reference, not an alternate height or relaxed normal oracle.
        const wx = 431.49967101907123,
          wz = 435.27231230204654;
        expect(witnessSurface.sample(wx - 450, wz - 450, out)).toBe(true);
        const h = 0.03125;
        const wnx =
          -(
            actual.getHeightAtComputed(wx + h, wz) -
            actual.getHeightAtComputed(wx - h, wz)
          ) /
          (2 * h);
        const wnz =
          -(
            actual.getHeightAtComputed(wx, wz + h) -
            actual.getHeightAtComputed(wx, wz - h)
          ) /
          (2 * h);
        const legacyAngle =
          (Math.acos(
            Math.max(
              -1,
              Math.min(
                1,
                (wnx * out.nx + out.ny + wnz * out.nz) /
                  Math.hypot(wnx, 1, wnz),
              ),
            ),
          ) *
            180) /
          Math.PI;
        const index = witnessGeometry.index!,
          p = witnessGeometry.getAttribute("position");
        const legacyNormal = [out.nx, out.ny, out.nz];
        const legacyTriangle = [0, 1, 2].map((corner) => {
          const id = index.getX(out.faceIndex * 3 + corner);
          return [p.getX(id) + 450, p.getY(id), p.getZ(id) + 450];
        });
        expect(rows[0].surface.sample(wx - 450, wz - 450, out)).toBe(true);
        const repairedAngle =
          (Math.acos(
            Math.max(
              -1,
              Math.min(
                1,
                (wnx * out.nx + out.ny + wnz * out.nz) /
                  Math.hypot(wnx, 1, wnz),
              ),
            ),
          ) *
            180) /
          Math.PI;
        expect(repairedAngle).toBeLessThan(6);
        process.stdout.write(
          `Inland legacy shoulder normal witness ${JSON.stringify({ point: [wx, wz], legacyAngle, repairedAngle, legacyNormal, legacyTriangle })}\n`,
        );
        expect(maximumError).toBeLessThanOrEqual(0.02);
        expect(maximumNormalAngle).toBeLessThanOrEqual(6);
      } finally {
        geometries.forEach((geometry) => geometry.dispose());
        await world.destroy();
      }
    },
    30000,
  );

  it("preserves captured fine pond seam buffers while rejecting unsupported full-pond coarse cells", () => {
    const fingerprints = [250, 350].map((centerZ) => {
      const terrain = provider();
      const result = assembleQuadChunkGeometry(
        generateQuadChunkDataSync(350, centerZ, 100, 128, terrain),
        terrain,
        3,
      );
      try {
        const hash = createHash("sha256");
        for (const [name, attribute] of Object.entries(
          result.geometry.attributes,
        )) {
          hash.update(name);
          hash.update(
            new Uint8Array(
              attribute.array.buffer,
              attribute.array.byteOffset,
              attribute.array.byteLength,
            ),
          );
        }
        const indices = result.geometry.index!.array;
        hash.update(
          new Uint8Array(
            indices.buffer,
            indices.byteOffset,
            indices.byteLength,
          ),
        );
        hash.update(
          JSON.stringify(result.geometry.userData.terrainCellTopology),
        );
        expect(
          retained(result, 128, 350, centerZ).matchesGeometry(result.geometry),
        ).toBe(true);
        return hash.digest("hex");
      } finally {
        result.geometry.dispose();
      }
    });
    // Captured before the mirrored-halo correction; includes every attribute,
    // main/skirt index and exact retained-cell topology on both sides of Z=300.
    expect(fingerprints).toEqual([
      "dc3d218a4cefb0cc02bebbfe64f9c935aa8dd35d62b02920cc91da756398f42e",
      "ad5a5ae4c75ee2034bc71985ec48f195039957200034bb07bafeb424e5a23f41",
    ]);
    const coarse = provider();
    const worker = generateQuadChunkDataSync(0, 0, 1600, 2, coarse);
    const before = worker.heightData.slice();
    expect(() => assembleQuadChunkGeometry(worker, coarse, 3)).toThrow(
      /limit|budget/i,
    );
    expect(worker.heightData).toEqual(before);
  });

  it.each([
    [-400, 400],
    [400, -400],
    [1200, 400],
    [400, 1200],
  ])(
    "does not project a remote pond across an unsupported coarse neighbour onto ocean-only cell %i,%i",
    (centerX, centerZ) => {
      // The pond is hundreds of metres beyond each cell's nearest edge. The old mirrored halo
      // extended a complete 800 m neighbouring cell and attempted a .125 m grid
      // over this entire ocean cell even though no feature reaches its boundary.
      const terrain = new AnalyticTerrain(plane, () => null, undefined, [ring]);
      const worker = generateQuadChunkDataSync(
        centerX,
        centerZ,
        800,
        2,
        terrain,
      );
      const original = worker.heightData.slice();
      const result = assembleQuadChunkGeometry(worker, terrain, 3);
      try {
        expect(result.geometry.userData.terrainCellTopology).toBeUndefined();
        expect(result.geometry.getAttribute("position").count).toBe(12);
        expect(result.geometry.index!.count).toBe(30);
        expect(
          retained(result, 2, centerX, centerZ, 800).matchesGeometry(
            result.geometry,
          ),
        ).toBe(true);
        expect(worker.heightData).toEqual(original);
      } finally {
        result.geometry.dispose();
      }
    },
  );

  it("retains the two-sector candidate bank within 2 cm using the original 7.9 m annulus at resolution 128", () => {
    // Isolate the actual authored candidate over constant surrounding 28.15 m
    // ground with no roads. This is neither full-world grounding admission nor
    // a claim that every future sector profile needs only the original ring.
    const candidate: AuthoredTerrainZone = {
      ...pond,
      radialPond: {
        ...pond.radialPond!,
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
    const authored: HeightField = (x, z) =>
      operations.resolveRadialPondTerrainHeight(candidate, x, z, () => 28.15) ??
      28.15;
    const resolution = 128,
      geometries: THREE.BufferGeometry[] = [];
    try {
      const cases = [7.9, 9].map((outerRadius) => {
        const terrain = new AnalyticTerrain(authored, () => null, undefined, [
          { ...ring, outerRadius },
        ]);
        const chunks = [250, 350].map((centerZ) => {
          const result = assembleQuadChunkGeometry(
            generateQuadChunkDataSync(350, centerZ, 100, resolution, terrain),
            terrain,
            3,
          );
          geometries.push(result.geometry);
          return {
            centerZ,
            geometry: result.geometry,
            surface: retained(result, resolution, 350, centerZ),
          };
        });
        const out = sample();
        const at = (index: number, x: number, z: number) => {
          const chunk = chunks[index];
          if (!chunk.surface.sample(x - 350, z - chunk.centerZ, out))
            throw new Error("Candidate retained pond triangle missing");
          return out.height;
        };
        return {
          outerRadius,
          at,
          height: (x: number, z: number) => at(z < 300 ? 0 : 1, x, z),
          vertices: chunks.reduce(
            (sum, chunk) => sum + chunk.geometry.getAttribute("position").count,
            0,
          ),
          triangles: chunks.reduce(
            (sum, chunk) => sum + chunk.geometry.index!.count / 3,
            0,
          ),
        };
      });
      const [original, expanded] = cases;
      let maximumOuterError = 0,
        maximumWaterError = 0,
        maximumWaterDifference = 0,
        maximumSharedEdgeDifference = 0;
      // Includes the independently observed worst point: 221 degrees, 8.63 m.
      // One-degree rays and centimetre radial steps sample the shallow sector
      // tail outside the original envelope, not just the waterline or centres.
      for (let degrees = 0; degrees < 360; degrees++) {
        const angle = (degrees * Math.PI) / 180;
        for (let radialStep = 0; radialStep <= 110; radialStep++) {
          const radius = 7.9 + radialStep * 0.01,
            x = pond.centerX + Math.cos(angle) * radius,
            z = pond.centerZ + Math.sin(angle) * radius;
          maximumOuterError = Math.max(
            maximumOuterError,
            Math.abs(original.height(x, z) - authored(x, z)),
          );
        }
        const actual = crossing(original.height, angle, 27.8);
        maximumWaterError = Math.max(
          maximumWaterError,
          Math.abs(actual - crossing(authored, angle, 27.8)),
        );
        maximumWaterDifference = Math.max(
          maximumWaterDifference,
          Math.abs(actual - crossing(expanded.height, angle, 27.8)),
        );
      }
      for (const row of cases)
        for (let i = 0; i <= 640; i++) {
          const x = pond.centerX - 10 + i / 32;
          maximumSharedEdgeDifference = Math.max(
            maximumSharedEdgeDifference,
            Math.abs(row.at(0, x, 300) - row.at(1, x, 300)),
          );
        }
      expect(maximumOuterError).toBeLessThan(0.02);
      expect(maximumWaterError).toBeLessThan(0.015);
      expect(maximumWaterDifference).toBeLessThan(1e-10);
      expect(maximumSharedEdgeDifference).toBeLessThan(1e-10);
      // Bound actual emitted geometry, without inferring GPU or grounding time.
      expect(original.vertices).toBeLessThanOrEqual(62760);
      expect(original.triangles).toBeLessThanOrEqual(124132);
      expect(expanded.vertices - original.vertices).toBeGreaterThanOrEqual(
        9600,
      );
      expect(expanded.triangles - original.triangles).toBeGreaterThanOrEqual(
        19000,
      );
      process.stdout.write(
        `Candidate sector annulus ${JSON.stringify({ maximumOuterError, maximumWaterError, maximumWaterDifference, maximumSharedEdgeDifference, cost: cases.map(({ outerRadius, vertices, triangles }) => ({ outerRadius, vertices, triangles })), surroundingHeight: 28.15, outerBankSamples: 39960, nativeOrFullWorldGroundingAcceptance: false })}\n`,
      );
    } finally {
      geometries.forEach((geometry) => geometry.dispose());
    }
  });

  // A content-identified default world cannot hot-swap its admitted profile.
  // This actual-world geometry gate runs in a fresh candidate ASSETS_DIR startup.
  it.skipIf(!DataManager.getWorldTerrainProfile().southernMeadow)(
    "refines paired shoulders on the actual terrain owner within 2 cm with measured bounded geometry and closed leaf seams",
    () => {
      const world = Object.assign(new World(), { config: { terrainSeed: 0 } });
      const terrain = new TerrainSystem(world);
      terrain["initializeTerrainGenerator"]();
      terrain["loadFlatZonesFromManifest"]();
      const original = terrain["flatZones"].get("haven_pond_floor")!;
      terrain.registerFlatZone({
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
            {
              bearing: -0.47123889803846897,
              halfWidth: 0.41887902047863906,
              innerRadius: 6.55,
              innerHeight: 28.08,
            },
            {
              bearing: 0.7,
              halfWidth: 0.55,
              innerRadius: 6.4,
              innerHeight: 27.86,
            },
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
      });
      const actualProvider = terrain["buildChunkTerrainProvider"]();
      const annuli: readonly TerrainSurfaceRefinementAnnulus[] =
        actualProvider.surfaceRefinementAnnuli!;
      expect(annuli).toEqual([
        ring,
        {
          centerX: 343,
          centerZ: 302,
          innerRadius: 7.9,
          outerRadius: 11,
          bearing: -2.321287905152458,
          halfWidth: 0.6981317007977318,
        },
        {
          centerX: 343,
          centerZ: 302,
          innerRadius: 7.9,
          outerRadius: 11,
          bearing: -1.5533430342749532,
          halfWidth: 0.8726646259971648,
        },
      ]);
      const geometry: THREE.BufferGeometry[] = [];
      try {
        const cases = [false, true].map((shoulders) => {
          const owner: FullTerrainProvider = {
            ...actualProvider,
            surfaceRefinementAnnuli: shoulders
              ? annuli
              : annuli.filter((row) => row.bearing === undefined),
          };
          const chunks = [250, 350].map((centerZ) => {
            const result = assembleQuadChunkGeometry(
              generateQuadChunkDataSync(350, centerZ, 100, 128, owner),
              owner,
              3,
            );
            geometry.push(result.geometry);
            return {
              centerZ,
              ...result,
              surface: retained(result, 128, 350, centerZ),
            };
          });
          const out = sample();
          const height = (x: number, z: number) => {
            const chunk = chunks[z < 300 ? 0 : 1];
            if (!chunk.surface.sample(x - 350, z - chunk.centerZ, out))
              throw new Error("Missing paired shoulder retained triangle");
            return out.height;
          };
          return {
            shoulders,
            chunks,
            height,
            vertices: chunks.reduce(
              (sum, row) => sum + row.geometry.getAttribute("position").count,
              0,
            ),
            triangles: chunks.reduce(
              (sum, row) => sum + row.geometry.index!.count / 3,
              0,
            ),
          };
        });
        const [before, after] = cases;
        const failedX = 347.6029052734375,
          failedZ = 292.5626525878906;
        const target = actualProvider.getHeightAtComputed(failedX, failedZ);
        const oldFailure = Math.abs(before.height(failedX, failedZ) - target);
        const correctedFailure = Math.abs(
          after.height(failedX, failedZ) - target,
        );
        expect(oldFailure).toBeGreaterThan(0.02);
        expect(correctedFailure).toBeLessThan(0.02);
        let probes = 0,
          maximumError = 0;
        for (let degrees = 187; degrees <= 321; degrees++) {
          const angle = (degrees * Math.PI) / 180;
          for (let step = 0; step <= 62; step++) {
            const radius = 7.9 + step * 0.05;
            const x = Math.fround(343 + radius * Math.cos(angle));
            const z = Math.fround(302 + radius * Math.sin(angle));
            maximumError = Math.max(
              maximumError,
              Math.abs(
                after.height(x, z) - actualProvider.getHeightAtComputed(x, z),
              ),
            );
            probes++;
          }
        }
        expect(maximumError).toBeLessThanOrEqual(0.02);
        const edges = after.chunks.map((chunk, side) => {
          const p = chunk.geometry.getAttribute("position"),
            n = chunk.geometry.getAttribute("normal");
          const topology = chunk.geometry.userData
            .terrainCellTopology as CellTopology;
          const edge = new Map<number, readonly number[]>();
          for (let id = 0; id < topology.surfaceVertexCount; id++)
            if (p.getZ(id) === (side === 0 ? 50 : -50))
              edge.set(p.getX(id), [
                p.getY(id),
                n.getX(id),
                n.getY(id),
                n.getZ(id),
              ]);
          for (let id = topology.surfaceVertexCount; id < p.count; id++)
            if (p.getZ(id) === (side === 0 ? 50 : -50)) {
              const top = edge.get(p.getX(id));
              expect(top).toBeDefined();
              expect(p.getY(id)).toBe(Math.fround(top![0] - 3));
              expect([n.getX(id), n.getY(id), n.getZ(id)]).toEqual(
                top!.slice(1),
              );
            }
          return [...edge].sort((a, b) => a[0] - b[0]);
        });
        expect(edges[0]).toEqual(edges[1]);
        const addedVertices = after.vertices - before.vertices;
        const addedTriangles = after.triangles - before.triangles;
        expect(addedVertices).toBeGreaterThan(0);
        expect(addedVertices).toBeLessThan(8000);
        expect(addedTriangles).toBeGreaterThan(0);
        expect(addedTriangles).toBeLessThan(16000);
        process.stdout.write(
          `Paired shoulder geometry ${JSON.stringify({
            oldFailure,
            correctedFailure,
            maximumError,
            probes,
            addedVertices,
            addedTriangles,
            cost: cases.map(({ shoulders, vertices, triangles }) => ({
              shoulders,
              vertices,
              triangles,
            })),
            sharedEdgeVertices: edges[0].length,
            nativePhysicsOrPerformanceAcceptance: false,
          })}\n`,
        );
      } finally {
        geometry.forEach((row) => row.dispose());
      }
    },
  );

  it.each([0, Math.PI, -Math.PI])(
    "retains thin paired shoulder wedges crossing cells without a corner inside at bearing %s",
    (bearing) => {
      const direction = Math.cos(bearing);
      const centerX = 9 * direction,
        centerZ = 0,
        size = 4,
        resolution = 8;
      const annulus: TerrainSurfaceRefinementAnnulus = {
        centerX: 0,
        centerZ: 0,
        innerRadius: 7.9,
        outerRadius: 11,
        bearing,
        halfWidth: 0.001,
      };
      const owner = new AnalyticTerrain(
        (x, z) => 28 + 0.04 * x * x + 0.2 * z * z,
        () => null,
        undefined,
        [annulus],
      );
      const result = assembleQuadChunkGeometry(
        generateQuadChunkDataSync(centerX, centerZ, size, resolution, owner),
        owner,
        3,
      );
      try {
        // The straddling base row is at +/-2/7: all four corners miss this wedge.
        for (const x of [centerX - 2 / 7, centerX + 2 / 7])
          for (const z of [-2 / 7, 2 / 7]) {
            const difference = Math.abs(Math.atan2(z, x) - bearing);
            expect(
              Math.min(difference, 2 * Math.PI - difference),
            ).toBeGreaterThan(annulus.halfWidth!);
          }
        const surface = retained(result, resolution, centerX, centerZ, size);
        const out = sample();
        expect(surface.sample(0, 0, out)).toBe(true);
        expect(
          Math.abs(out.height - owner.getHeightAtComputed(centerX, centerZ)),
        ).toBeLessThan(0.002);
        const p = result.geometry.getAttribute("position");
        let found = false;
        const used = new Set(result.geometry.index!.array);
        for (let id = resolution * resolution; id < p.count; id++)
          if (p.getZ(id) === 0 && used.has(id)) found = true;
        expect(found).toBe(true);
      } finally {
        result.geometry.dispose();
      }
    },
  );

  it("leaves unselected angular regions byte-exact and rejects malformed paired shoulder descriptors", () => {
    const shoulder = {
      centerX: 0,
      centerZ: 0,
      innerRadius: 7.9,
      outerRadius: 11,
      bearing: 0,
      halfWidth: 0.1,
    };
    const raw = new AnalyticTerrain(plane);
    const worker = generateQuadChunkDataSync(-9, 0, 2, 32, raw);
    const results = [[], [shoulder]].map((annuli) =>
      assembleQuadChunkGeometry(
        worker,
        new AnalyticTerrain(plane, () => null, undefined, annuli),
        3,
      ),
    );
    try {
      expect(results[1].geometry.index!.array).toEqual(
        results[0].geometry.index!.array,
      );
      for (const name of Object.keys(results[0].geometry.attributes))
        expect(results[1].geometry.getAttribute(name).array).toEqual(
          results[0].geometry.getAttribute(name).array,
        );
      expect(results[1].geometry.userData.terrainCellTopology).toBeUndefined();
    } finally {
      results.forEach((row) => row.geometry.dispose());
    }
    const { bearing: _bearing, halfWidth: _halfWidth, ...base } = shoulder;
    for (const invalid of [
      { ...base, bearing: 0 },
      { ...base, halfWidth: 0.1 },
      { ...shoulder, bearing: undefined },
      { ...shoulder, bearing: NaN },
      { ...shoulder, bearing: Math.PI + 0.001 },
      { ...shoulder, halfWidth: 0 },
      { ...shoulder, halfWidth: Math.PI / 2 + 0.001 },
    ])
      expect(() =>
        assembleQuadChunkGeometry(
          worker,
          new AnalyticTerrain(plane, () => null, undefined, [invalid]),
          3,
        ),
      ).toThrow(/angular shoulder/);
  });

  it.each([128])(
    "resolves the actual lobed pond contour across angles and varying thresholds at resolution %i",
    (resolution) => {
      const terrain = provider(),
        chunks = [250, 350].map((centerZ) => {
          const worker = generateQuadChunkDataSync(
            350,
            centerZ,
            100,
            resolution,
            terrain,
          );
          return {
            centerZ,
            plain: assembleQuadChunkGeometry(worker, provider([]), 3),
            refined: assembleQuadChunkGeometry(worker, terrain, 3),
          };
        });
      try {
        const surfaces = ["plain", "refined"].map((kind) =>
            chunks.map((chunk) =>
              retained(
                chunk[kind as "plain" | "refined"],
                resolution,
                350,
                chunk.centerZ,
              ),
            ),
          ),
          out = sample();
        const heights = surfaces.map((leaves) => (x: number, z: number) => {
          const index = z < 300 ? 0 : 1;
          if (!leaves[index].sample(x - 350, z - chunks[index].centerZ, out))
            throw new Error("Actual retained pond triangle missing");
          return out.height;
        });
        let plainMaximum = 0,
          refinedMaximum = 0,
          verticalMaximum = 0,
          normalMaximumDegrees = 0,
          count = 0;
        let worstContour = {
          angle: 0,
          level: 0,
          radius: 0,
          after: 0,
          x: 0,
          z: 0,
        };
        const thresholdRows = new Map<string, number>();
        for (const base of [27.8, 27.91, 28.02])
          for (const varyThreshold of [false, true])
            for (let i = 0; i < 384; i++) {
              const angle = ((i + 0.371) / 384) * Math.PI * 2;
              // Vary the effective wet/dry threshold as well as the angle: one
              // convenient water level cannot qualify a noisy shoreline mask.
              const level =
                base + (varyThreshold ? 0.05 * Math.sin(13 * angle + base) : 0);
              const radius = crossing(canonical, angle, level),
                before = crossing(heights[0], angle, level),
                after = crossing(heights[1], angle, level);
              plainMaximum = Math.max(plainMaximum, Math.abs(before - radius));
              const error = Math.abs(after - radius),
                label = base + "/" + (varyThreshold ? "varied" : "exact");
              thresholdRows.set(
                label,
                Math.max(thresholdRows.get(label) ?? 0, error),
              );
              if (error > refinedMaximum)
                worstContour = {
                  angle,
                  level,
                  radius,
                  after,
                  x: pond.centerX + radius * Math.cos(angle),
                  z: pond.centerZ + radius * Math.sin(angle),
                };
              refinedMaximum = Math.max(
                refinedMaximum,
                Math.abs(after - radius),
              );
              const x = pond.centerX + radius * Math.cos(angle),
                z = pond.centerZ + radius * Math.sin(angle);
              verticalMaximum = Math.max(
                verticalMaximum,
                Math.abs(heights[1](x, z) - canonical(x, z)),
              );
              const h = 0.001,
                nx = -(canonical(x + h, z) - canonical(x - h, z)) / (2 * h),
                nz = -(canonical(x, z + h) - canonical(x, z - h)) / (2 * h),
                length = Math.hypot(nx, 1, nz);
              const dot = (out.nx * nx + out.ny + out.nz * nz) / length;
              normalMaximumDegrees = Math.max(
                normalMaximumDegrees,
                (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI,
              );
              count++;
            }
        let fullBankMaximum = 0,
          bankSamples = 0;
        for (let a = 0; a < 128; a++)
          for (let r = 0; r <= 104; r++) {
            const angle = ((a + 0.217) * Math.PI * 2) / 128,
              radius = 3.8 + r * 0.05,
              x = pond.centerX + radius * Math.cos(angle),
              z = pond.centerZ + radius * Math.sin(angle);
            fullBankMaximum = Math.max(
              fullBankMaximum,
              Math.abs(heights[1](x, z) - canonical(x, z)),
            );
            bankSamples++;
          }
        const cost = chunks.map((chunk) => {
          const p = chunk.plain.geometry,
            r = chunk.refined.geometry;
          const bytes = (g: THREE.BufferGeometry) =>
            Object.values(g.attributes).reduce(
              (n, a) => n + a.array.byteLength,
              0,
            ) + g.index!.array.byteLength;
          return {
            centerZ: chunk.centerZ,
            addedVertices:
              r.getAttribute("position").count -
              p.getAttribute("position").count,
            addedTriangles: (r.index!.count - p.index!.count) / 3,
            addedBytes: bytes(r) - bytes(p),
          };
        });
        heights[1](worstContour.x, worstContour.z);
        const worstChunk = chunks[worstContour.z < 300 ? 0 : 1],
          position = worstChunk.refined.geometry.getAttribute("position"),
          indices = worstChunk.refined.geometry.index!;
        const worstTriangle = [0, 1, 2].map((corner) => {
          const id = indices.getX(out.faceIndex * 3 + corner),
            x = 350 + position.getX(id),
            z = worstChunk.centerZ + position.getZ(id);
          return {
            id,
            x,
            z,
            height: position.getY(id),
            canonical: canonical(x, z),
          };
        });
        process.stdout.write(
          `Annular pond contour ${JSON.stringify({ resolution, count, plainMaximum, refinedMaximum, verticalMaximum, normalMaximumDegrees, fullBankMaximum, bankSamples, cost, worstContour, worstTriangle, thresholdRows: Object.fromEntries(thresholdRows), thresholdVariation: "synthetic angular threshold controls, not GPU-noise readback", nativeOrPerformanceAcceptance: false })}\n`,
        );
        expect(count).toBe(2304);
        expect(plainMaximum).toBeGreaterThan(0.03);
        expect(refinedMaximum).toBeLessThan(0.015);
        expect(refinedMaximum).toBeLessThan(plainMaximum / 5);
        expect(verticalMaximum).toBeLessThan(0.01);
        expect(fullBankMaximum).toBeLessThan(0.01);
        expect(normalMaximumDegrees).toBeLessThan(8);
      } finally {
        chunks.forEach((chunk) => {
          chunk.plain.geometry.dispose();
          chunk.refined.geometry.dispose();
        });
      }
    },
  );

  it.each([128])(
    "preserves the original grid, uses bounded closed cells and refines both world axes only near the ring at resolution %i",
    (resolution) => {
      const terrain = provider(),
        worker = generateQuadChunkDataSync(350, 350, 100, resolution, terrain),
        original = worker.heightData.slice();
      const plain = assembleQuadChunkGeometry(worker, provider([]), 3),
        result = assembleQuadChunkGeometry(worker, terrain, 3);
      try {
        const p = result.geometry.getAttribute("position"),
          topology = result.geometry.userData
            .terrainCellTopology as CellTopology;
        expect(
          Array.from(
            (p.array as Float32Array).subarray(0, resolution * resolution * 3),
          ),
        ).toEqual(
          Array.from(
            (
              plain.geometry.getAttribute("position").array as Float32Array
            ).subarray(0, resolution * resolution * 3),
          ),
        );
        expect(worker.heightData).toEqual(original);
        expect(result.heightData).toEqual(plain.heightData);
        expect(
          topology.surfaceVertexCount - resolution * resolution,
        ).toBeGreaterThan(5000);
        expect(
          topology.surfaceVertexCount - resolution * resolution,
        ).toBeLessThan(18000);
        expect(result.geometry.index!.count / 3).toBeLessThan(75000);
        let bothAxes = 0,
          maximumCellFaces = 0;
        for (
          let i = resolution * resolution;
          i < topology.surfaceVertexCount;
          i++
        ) {
          const x = 350 + p.getX(i),
            z = 350 + p.getZ(i),
            radius = Math.hypot(x - pond.centerX, z - pond.centerZ),
            gridStep = 100 / (resolution - 1),
            inBoundaryCell =
              Math.abs(p.getX(i)) >= 50 - gridStep - 1e-5 ||
              Math.abs(p.getZ(i)) >= 50 - gridStep - 1e-5,
            // Shared-edge ownership may mirror one incident cell across the
            // boundary. This allowance never expands interior ring support.
            support = Math.SQRT2 * gridStep + (inBoundaryCell ? gridStep : 0);
          expect(radius).toBeGreaterThanOrEqual(
            ring.innerRadius - support - 1e-5,
          );
          expect(radius).toBeLessThanOrEqual(ring.outerRadius + support + 1e-5);
          if (
            Math.abs(x * 8 - Math.round(x * 8)) < 1e-6 &&
            Math.abs(z * 8 - Math.round(z * 8)) < 1e-6
          )
            bothAxes++;
        }
        expect(bothAxes).toBeGreaterThan(5000);
        for (let i = 0; i < topology.cellIndexOffsets.length - 1; i++)
          maximumCellFaces = Math.max(
            maximumCellFaces,
            (topology.cellIndexOffsets[i + 1] - topology.cellIndexOffsets[i]) /
              3,
          );
        expect(maximumCellFaces).toBeLessThanOrEqual(512);
        for (const attribute of Object.values(result.geometry.attributes)) {
          expect(attribute.count).toBe(p.count);
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        }
        // The real retained owner validates triangle winding, per-cell area,
        // no-overlap coverage, manifold edges and neighbouring cell agreement.
        expect(
          retained(result, resolution).matchesGeometry(result.geometry),
        ).toBe(true);
        process.stdout.write(
          `Annular pond bounds ${JSON.stringify({ resolution, vertices: p.count, added: topology.surfaceVertexCount - resolution * resolution, bothAxes, triangles: result.geometry.index!.count / 3, maximumCellFaces, nativeOrPerformanceAcceptance: false })}\n`,
        );
      } finally {
        plain.geometry.dispose();
        result.geometry.dispose();
      }
    },
  );

  it.each([128])(
    "matches world-anchored shared-edge vertices, normals and skirt copies on same-level pond neighbours at resolution %i",
    (resolution) => {
      const terrain = provider(),
        chunks = [pond.centerX - 50, pond.centerX + 50].map((centerX) => ({
          centerX,
          ...assembleQuadChunkGeometry(
            generateQuadChunkDataSync(
              centerX,
              pond.centerZ,
              100,
              resolution,
              terrain,
            ),
            terrain,
            3,
          ),
        }));
      try {
        const edges = chunks.map((chunk, side) => {
          expect(
            retained(
              chunk,
              resolution,
              chunk.centerX,
              pond.centerZ,
            ).matchesGeometry(chunk.geometry),
          ).toBe(true);
          const p = chunk.geometry.getAttribute("position"),
            n = chunk.geometry.getAttribute("normal"),
            topology = chunk.geometry.userData
              .terrainCellTopology as CellTopology;
          const edge = new Map<number, readonly number[]>();
          for (let id = 0; id < topology.surfaceVertexCount; id++)
            if (p.getX(id) === (side === 0 ? 50 : -50))
              edge.set(p.getZ(id), [
                p.getY(id),
                n.getX(id),
                n.getY(id),
                n.getZ(id),
              ]);
          expect(edge.size).toBeGreaterThan(resolution + 40);
          for (let id = topology.surfaceVertexCount; id < p.count; id++)
            if (p.getX(id) === (side === 0 ? 50 : -50)) {
              const top = edge.get(p.getZ(id));
              expect(top).toBeDefined();
              expect(p.getY(id)).toBe(Math.fround(top![0] - 3));
              expect([n.getX(id), n.getY(id), n.getZ(id)]).toEqual(
                top!.slice(1),
              );
            }
          return [...edge].sort((a, b) => a[0] - b[0]);
        });
        expect(edges[0]).toEqual(edges[1]);
      } finally {
        chunks.forEach((chunk) => chunk.geometry.dispose());
      }
    },
  );

  it("retains exact geometry for absent, empty, non-intersecting and inner-hole annuli", () => {
    for (const spec of [
      { centerX: 0, centerZ: 0, size: 100 },
      { centerX: pond.centerX, centerZ: pond.centerZ, size: 2 },
      { centerX: pond.centerX + 6, centerZ: pond.centerZ + 6, size: 0.5 },
    ]) {
      const raw = provider([]),
        worker = generateQuadChunkDataSync(
          spec.centerX,
          spec.centerZ,
          spec.size,
          64,
          raw,
        );
      const results = [undefined, [], [ring]].map((annuli) =>
        assembleQuadChunkGeometry(
          worker,
          new AnalyticTerrain(canonical, () => null, undefined, annuli),
          3,
        ),
      );
      try {
        for (const result of results) {
          expect(result.geometry.userData.terrainCellTopology).toBeUndefined();
          expect(result.geometry.index!.array).toEqual(
            results[0].geometry.index!.array,
          );
          for (const name of Object.keys(result.geometry.attributes))
            expect(result.geometry.getAttribute(name).array).toEqual(
              results[0].geometry.getAttribute(name).array,
            );
        }
      } finally {
        results.forEach((result) => result.geometry.dispose());
      }
    }
  });

  it("rejects invalid, over-cap and excessive combined annuli without mutating worker heights", () => {
    const raw = provider([]),
      worker = generateQuadChunkDataSync(350, 350, 100, 128, raw),
      original = worker.heightData.slice();
    for (const annuli of [
      [{ ...ring, centerX: NaN }],
      [{ ...ring, centerZ: Infinity }],
      [{ ...ring, innerRadius: -1 }],
      [{ ...ring, outerRadius: 0 }],
      [{ ...ring, innerRadius: 7.9 }],
      [{ ...ring, outerRadius: 65 }],
      Array.from({ length: 17 }, () => ring),
    ]) {
      expect(() =>
        assembleQuadChunkGeometry(worker, provider(annuli), 3),
      ).toThrow();
      expect(worker.heightData).toEqual(original);
    }
    const collar: TerrainSurfaceRefinementZone = {
      minX: 340,
      maxX: 344,
      minZ: 300,
      maxZ: 304,
      blendRadius: 1,
    };
    expect(() =>
      assembleQuadChunkGeometry(
        worker,
        new AnalyticTerrain(
          canonical,
          () => null,
          [collar],
          Array.from({ length: 16 }, () => ring),
        ),
        3,
      ),
    ).toThrow(/feature limit/);
  });

  it.each([64, 32])(
    "fails closed and disposes private geometry for the actual pond at unsupported resolution %i without raising cell caps",
    (resolution) => {
      const terrain = provider(),
        worker = generateQuadChunkDataSync(350, 350, 100, resolution, terrain),
        original = worker.heightData.slice();
      const dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
      try {
        expect(() => assembleQuadChunkGeometry(worker, terrain, 3)).toThrow(
          /cell.*limit|cell.*budget/i,
        );
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(worker.heightData).toEqual(original);
      } finally {
        dispose.mockRestore();
      }
    },
  );

  it.each(["flat", "planar"] as const)(
    "does not emit adaptive fine interior vertices or decision probes on %s annular ground",
    (kind) => {
      const centerX = 343.03125,
        centerZ = 302.09375,
        size = 32,
        resolution = 128,
        height: HeightField =
          kind === "flat" ? () => 28 : (x, z) => 28 + x * 0.125 - z * 0.0625,
        terrain = new AnalyticTerrain(height, () => null, undefined, [
          { ...ring, centerX, centerZ },
        ]),
        worker = generateQuadChunkDataSync(
          centerX,
          centerZ,
          size,
          resolution,
          terrain,
        ),
        result = assembleQuadChunkGeometry(worker, terrain, 3);
      try {
        const p = result.geometry.getAttribute("position"),
          topology = result.geometry.userData
            .terrainCellTopology as CellTopology,
          originalX = new Set<number>(),
          originalZ = new Set<number>();
        for (let i = 0; i < resolution; i++) {
          originalX.add(p.getX(i));
          originalZ.add(p.getZ(i * resolution));
        }
        const onBaseAxes = (id: number) =>
            (originalX.has(p.getX(id)) ||
              Number.isInteger((centerX + p.getX(id)) * 8)) &&
            (originalZ.has(p.getZ(id)) ||
              Number.isInteger((centerZ + p.getZ(id)) * 8)),
          fans = new Map<number, { neighbours: Set<number>; faces: number }>();
        for (
          let i = resolution * resolution;
          i < topology.surfaceVertexCount;
          i++
        )
          if (!onBaseAxes(i)) fans.set(i, { neighbours: new Set(), faces: 0 });
        const indices = result.geometry.index!;
        for (
          let i = 0;
          i < topology.cellIndexOffsets[topology.cellIndexOffsets.length - 1];
          i += 3
        ) {
          const triangle = [
            indices.getX(i),
            indices.getX(i + 1),
            indices.getX(i + 2),
          ];
          for (const id of triangle) {
            const fan = fans.get(id);
            if (!fan) continue;
            fan.faces++;
            triangle.forEach((other) => {
              if (other !== id) fan.neighbours.add(other);
            });
          }
        }
        // Cell stitching legitimately emits a centre fan when adjoining cells
        // contain extra edge cuts. Prove every off-axis vertex is exactly that
        // fan, bounded by base-grid/.125 vertices, not an adaptive fine patch.
        for (const [id, fan] of fans) {
          expect(fan.neighbours.size).toBeGreaterThanOrEqual(5);
          expect(fan.faces).toBe(fan.neighbours.size);
          const neighbours = [...fan.neighbours];
          expect(neighbours.every(onBaseAxes)).toBe(true);
          expect(p.getX(id)).toBe(
            Math.fround(
              neighbours.reduce((sum, n) => sum + p.getX(n), 0) /
                neighbours.length,
            ),
          );
          expect(p.getZ(id)).toBe(
            Math.fround(
              neighbours.reduce((sum, n) => sum + p.getZ(n), 0) /
                neighbours.length,
            ),
          );
        }
        let added = 0;
        for (
          let i = resolution * resolution;
          i < topology.surfaceVertexCount;
          i++
        ) {
          const x = p.getX(i),
            z = p.getZ(i);
          expect(onBaseAxes(i) || fans.has(i)).toBe(true);
          expect(
            Math.abs(p.getY(i) - height(centerX + x, centerZ + z)),
          ).toBeLessThan(0.00001);
          added++;
        }
        expect(added).toBeGreaterThan(1000);
        expect(
          retained(result, resolution, centerX, centerZ, size).matchesGeometry(
            result.geometry,
          ),
        ).toBe(true);
      } finally {
        result.geometry.dispose();
      }
    },
  );

  it.each([
    {
      name: "actual asymmetric inner-hole Z=300",
      axis: "z",
      seam: 300,
      tangent: 350,
      dx: 0,
      dz: 0,
      oneSided: false,
    },
    {
      name: "actual asymmetric outer-ring X=350",
      axis: "x",
      seam: 350,
      tangent: 300,
      dx: 0,
      dz: 0,
      oneSided: false,
    },
    {
      name: "translated clipped Z bank",
      axis: "z",
      seam: 300.03125,
      tangent: 350.09375,
      dx: 0.09375,
      dz: 0.03125,
      oneSided: false,
    },
    {
      name: "translated X one-sided curvature",
      axis: "x",
      seam: 343.03125,
      tangent: 302.09375,
      dx: 0.03125,
      dz: 0.09375,
      oneSided: true,
    },
    {
      name: "translated Z one-sided curvature",
      axis: "z",
      seam: 302.09375,
      tangent: 343.03125,
      dx: 0.03125,
      dz: 0.09375,
      oneSided: true,
    },
    {
      name: "wholly neighbouring ring at X=0 with nonflat shared chord",
      axis: "x",
      seam: 0,
      tangent: 0,
      dx: -351.25,
      dz: -302,
      oneSided: false,
    },
  ] as const)(
    "keeps matching closed edge vertices, normals and skirts across $name",
    (spec) => {
      const height: HeightField = spec.oneSided
          ? (x, z) =>
              28 +
              0.35 *
                (1 -
                  Math.cos(
                    Math.min(
                      2,
                      Math.max(0, (spec.axis === "x" ? x : z) - spec.seam),
                    ) * Math.PI,
                  ))
          : spec.seam === 0
            ? (x, z) => 28 + 0.02 * z * z + 0.1 * x
            : (x, z) => canonical(x - spec.dx, z - spec.dz),
        annulus = {
          ...ring,
          centerX: pond.centerX + spec.dx,
          centerZ: pond.centerZ + spec.dz,
        },
        terrain = new AnalyticTerrain(height, () => null, undefined, [annulus]),
        chunks = [-1, 1].map((side) => {
          const centerX =
              spec.axis === "x" ? spec.seam + side * 50 : spec.tangent,
            centerZ = spec.axis === "z" ? spec.seam + side * 50 : spec.tangent;
          return {
            centerX,
            centerZ,
            ...assembleQuadChunkGeometry(
              generateQuadChunkDataSync(centerX, centerZ, 100, 128, terrain),
              terrain,
              3,
            ),
          };
        });
      try {
        const edges = chunks.map((chunk, side) => {
          expect(
            retained(chunk, 128, chunk.centerX, chunk.centerZ).matchesGeometry(
              chunk.geometry,
            ),
          ).toBe(true);
          const p = chunk.geometry.getAttribute("position"),
            n = chunk.geometry.getAttribute("normal"),
            topology = chunk.geometry.userData
              .terrainCellTopology as CellTopology,
            edge = new Map<number, readonly number[]>(),
            across = (id: number) =>
              spec.axis === "x" ? p.getX(id) : p.getZ(id),
            along = (id: number) =>
              spec.axis === "x" ? p.getZ(id) : p.getX(id);
          for (let id = 0; id < topology.surfaceVertexCount; id++)
            if (across(id) === (side === 0 ? 50 : -50))
              edge.set(along(id), [
                p.getY(id),
                n.getX(id),
                n.getY(id),
                n.getZ(id),
              ]);
          expect(edge.size).toBeGreaterThan(168);
          for (let id = topology.surfaceVertexCount; id < p.count; id++)
            if (across(id) === (side === 0 ? 50 : -50)) {
              const top = edge.get(along(id));
              expect(top).toBeDefined();
              expect(p.getY(id)).toBe(Math.fround(top![0] - 3));
              expect([n.getX(id), n.getY(id), n.getZ(id)]).toEqual(
                top!.slice(1),
              );
            }
          return [...edge].sort((a, b) => a[0] - b[0]);
        });
        // Exact shared edge topology, not skirts concealing unmatched vertices.
        expect(
          edges[0].map(([coordinate]) => coordinate),
          spec.name,
        ).toEqual(edges[1].map(([coordinate]) => coordinate));
        expect(edges[0], spec.name).toEqual(edges[1]);
        if (spec.name === "actual asymmetric inner-hole Z=300") {
          const edgeWorldX = edges[0].map(([x]) => x + spec.tangent);
          expect(
            edgeWorldX.filter((x) => x > 345.6692914963 && x < 346.456692934)
              .length,
          ).toBeGreaterThan(8);
        }
        if (spec.oneSided) {
          const fineCounts = chunks.map((chunk, side) => {
            const p = chunk.geometry.getAttribute("position"),
              topology = chunk.geometry.userData
                .terrainCellTopology as CellTopology;
            let count = 0;
            for (let i = 128 * 128; i < topology.surfaceVertexCount; i++) {
              const x = chunk.centerX + p.getX(i),
                z = chunk.centerZ + p.getZ(i),
                distance = Math.abs((spec.axis === "x" ? x : z) - spec.seam);
              // Ignore the forced fine boundary cell itself. Curvature on only
              // one side must not change the neighbour's shared-edge contract.
              if (
                distance > 1 &&
                distance < 1.8 &&
                ((Number.isInteger(x * 16) && !Number.isInteger(x * 8)) ||
                  (Number.isInteger(z * 16) && !Number.isInteger(z * 8)))
              )
                count++;
            }
            if (side === 0) expect(count).toBe(0);
            return count;
          });
          expect(fineCounts[1]).toBeGreaterThan(0);
        }
      } finally {
        chunks.forEach((chunk) => chunk.geometry.dispose());
      }
    },
  );

  it("resumes exact adaptive annular sync/staged bytes with bounded canonical-query batches", () => {
    const syncProvider = provider(),
      stepProvider = provider(),
      bytes = (array: ArrayBufferView) =>
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      phases = new Map<string, { yields: number; heightQueries: number }>();
    const drain = <T>(
      steps: Generator<string, T, void>,
      maxHeights: number,
    ): T => {
      for (let count = 0; count < 100000; count++) {
        const before = [
            stepProvider.heightSamples,
            stepProvider.gradingSamples,
            stepProvider.roadSamples,
            stepProvider.biomeSamples,
          ],
          next = steps.next(),
          heightQueries = stepProvider.heightSamples - before[0];
        expect(heightQueries).toBeLessThanOrEqual(maxHeights);
        expect(stepProvider.gradingSamples - before[1]).toBeLessThanOrEqual(64);
        expect(stepProvider.roadSamples - before[2]).toBeLessThanOrEqual(32);
        expect(stepProvider.biomeSamples - before[3]).toBeLessThanOrEqual(32);
        if (next.done) return next.value;
        const phase = phases.get(next.value) ?? { yields: 0, heightQueries: 0 };
        phase.yields++;
        phase.heightQueries = Math.max(phase.heightQueries, heightQueries);
        phases.set(next.value, phase);
      }
      throw new Error(
        "Adaptive annular preparation exceeded bounded phase count",
      );
    };
    const syncData = generateQuadChunkDataSync(
        350,
        350,
        100,
        128,
        syncProvider,
      ),
      stepData = drain(
        generateQuadChunkDataSteps(350, 350, 100, 128, stepProvider),
        32,
      ),
      original = bytes(stepData.heightData).slice();
    expect(stepData).toEqual(syncData);
    const sync = assembleQuadChunkGeometry(syncData, syncProvider, 3);
    let staged: ReturnType<typeof assembleQuadChunkGeometry> | undefined;
    try {
      staged = drain(
        assembleQuadChunkGeometrySteps(stepData, stepProvider, 3),
        128,
      );
      expect(bytes(staged.heightData)).toEqual(bytes(sync.heightData));
      for (const [name, attribute] of Object.entries(
        sync.geometry.attributes,
      )) {
        const actual = staged.geometry.getAttribute(name);
        expect(actual.itemSize).toBe(attribute.itemSize);
        expect(bytes(actual.array)).toEqual(bytes(attribute.array));
      }
      expect(bytes(staged.geometry.index!.array)).toEqual(
        bytes(sync.geometry.index!.array),
      );
      expect(staged.geometry.userData.terrainCellTopology).toEqual(
        sync.geometry.userData.terrainCellTopology,
      );
      expect(staged.geometry.boundingBox).toEqual(sync.geometry.boundingBox);
      expect(staged.geometry.boundingSphere).toEqual(
        sync.geometry.boundingSphere,
      );
      expect(
        Object.isFrozen(staged.geometry.userData.terrainCellTopology),
      ).toBe(true);
      expect(bytes(stepData.heightData)).toEqual(original);
      expect(retained(staged, 128).matchesGeometry(staged.geometry)).toBe(true);
      for (const field of [
        "heightSamples",
        "gradingSamples",
        "roadSamples",
        "biomeSamples",
      ] as const)
        expect(stepProvider[field]).toBe(syncProvider[field]);
      for (const phase of [
        "collar_partition",
        "collar_vertex_attributes",
        "collar_vertex_normals",
        "collar_boundary_normals",
      ])
        expect(phases.has(phase), phase).toBe(true);
      expect(phases.get("collar_partition")!.heightQueries).toBeLessThanOrEqual(
        18,
      );
      process.stdout.write(
        `Adaptive annular stages ${JSON.stringify({ phases: Object.fromEntries(phases), nativeOrPerformanceAcceptance: false })}\n`,
      );
    } finally {
      sync.geometry.dispose();
      staged?.geometry.dispose();
    }
  });

  it("composes annular cells with a real authored floor collar without overlap or changing canonical floor/pond priority", () => {
    const grade = 28.15,
      originalFloor = createDuelArenaFloorZones(getDuelArenaConfig(), grade)[0];
    const floor: AuthoredTerrainZone = {
      ...originalFloor,
      centerX: 352,
      centerZ: 302,
      width: 2,
      depth: 6,
      blendRadius: 1,
    };
    const feature: TerrainSurfaceRefinementZone = {
      minX: 351,
      maxX: 353,
      minZ: 299,
      maxZ: 305,
      blendRadius: 1,
    };
    const ids = new Set([floor.id]);
    const authored: HeightField = (x, z) =>
      operations.resolveHeight([pond, floor], x, z, () => 28.15, ids, grade) ??
      28.15;
    const terrain = new AnalyticTerrain(
        authored,
        () => null,
        [feature],
        [ring],
      ),
      worker = generateQuadChunkDataSync(350, 300, 100, 128, terrain);
    const original = worker.heightData.slice(),
      plain = assembleQuadChunkGeometry(
        worker,
        new AnalyticTerrain(authored),
        3,
      ),
      floorOnly = assembleQuadChunkGeometry(
        worker,
        new AnalyticTerrain(authored, () => null, [feature]),
        3,
      ),
      result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      const surface = retained(result, 128, 350, 300),
        prior = retained(floorOnly, 128, 350, 300),
        out = sample(),
        priorOut = sample();
      let maximumError = 0,
        count = 0,
        outsideMaximum = 0,
        outsideSamples = 0,
        outsideDifference = 0;
      // Both actual feature partitions cross here; admitting the retained mesh
      // checks real per-cell triangle coverage, manifold edges and neighbours.
      expect(surface.matchesGeometry(result.geometry)).toBe(true);
      for (let iz = 0; iz <= 96; iz++)
        for (let ix = 0; ix <= 64; ix++) {
          const x = 349.5 + ix * 0.071,
            z = 298.2 + iz * 0.079;
          expect(surface.sample(x - 350, z - 300, out)).toBe(true);
          const error = Math.abs(out.height - authored(x, z)),
            radius = Math.hypot(x - pond.centerX, z - pond.centerZ);
          if (radius <= ring.outerRadius) {
            maximumError = Math.max(maximumError, error);
            count++;
          } else outsideMaximum = Math.max(outsideMaximum, error);
          if (radius > ring.outerRadius) {
            expect(prior.sample(x - 350, z - 300, priorOut)).toBe(true);
            outsideDifference = Math.max(
              outsideDifference,
              Math.abs(out.height - priorOut.height),
            );
            outsideSamples++;
          }
        }
      expect(maximumError).toBeLessThan(0.025);
      expect(count).toBeGreaterThan(1000);
      expect(outsideSamples).toBeGreaterThan(1000);
      expect(authored(343, 302)).toBe(pond.height);
      expect(authored(350.5, 302)).toBe(28.08);
      expect(authored(353, 302)).toBe(28.08 + (floor.height - 28.08) * 0.5);
      expect(worker.heightData).toEqual(original);
      expect(result.heightData).toEqual(plain.heightData);
      expect(
        (
          result.geometry.getAttribute("position").array as Float32Array
        ).subarray(0, 128 * 128 * 3),
      ).toEqual(
        (
          plain.geometry.getAttribute("position").array as Float32Array
        ).subarray(0, 128 * 128 * 3),
      );
      const topology = result.geometry.userData
        .terrainCellTopology as CellTopology;
      for (let i = 0; i < topology.cellIndexOffsets.length - 1; i++)
        expect(
          (topology.cellIndexOffsets[i + 1] - topology.cellIndexOffsets[i]) / 3,
        ).toBeLessThanOrEqual(512);
      process.stdout.write(
        `Annular pond floor overlap ${JSON.stringify({ count, maximumError, outsideMaximum, outsideSamples, outsideDifference, outsideQualityApproved: false, nativeOrGameplayAcceptance: false })}\n`,
      );
    } finally {
      plain.geometry.dispose();
      floorOnly.geometry.dispose();
      result.geometry.dispose();
    }
  });

  it("cancels annular preparation by disposing the real private geometry once, with no returned mesh or further provider queries", () => {
    const terrain = provider(),
      worker = generateQuadChunkDataSync(350, 350, 100, 128, terrain),
      original = worker.heightData.slice();
    // Call-through observation only: real BufferGeometry.dispose executes.
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    try {
      for (const phase of [
        "collar_partition",
        "collar_install_attributes",
        "collar_vertex_normals",
      ]) {
        const iterator = assembleQuadChunkGeometrySteps(worker, terrain, 3);
        let step = iterator.next(),
          steps = 0;
        while (!step.done && step.value !== phase) {
          step = iterator.next();
          if (++steps > 100000)
            throw new Error("Annular cancellation phase was not bounded");
        }
        expect(step.done).toBe(false);
        const before = dispose.mock.calls.length,
          queries = terrain.heightSamples;
        expect(iterator.return(undefined as never)).toEqual({
          done: true,
          value: undefined,
        });
        expect(dispose.mock.calls.length - before).toBe(1);
        expect(iterator.next()).toEqual({ done: true, value: undefined });
        expect(terrain.heightSamples).toBe(queries);
        expect(worker.heightData).toEqual(original);
      }
    } finally {
      dispose.mockRestore();
    }
  });
});

describe("quad terrain final surface", () => {
  it("retains the worker height allocation when no live grading applies", () => {
    const terrain = new AnalyticTerrain(plane);
    const worker = generateQuadChunkDataSync(0, 0, 8, 5, terrain);
    terrain.heightSamples = 0;
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      expect(result.heightData).toBe(worker.heightData);
      expect(terrain.heightSamples).toBe(0);
      expect(terrain.gradingSamples).toBe(5 * 5 + 4 * 5);
      const positions = result.geometry.getAttribute("position");
      for (let i = 0; i < result.heightData.length; i++) {
        expect(positions.getY(i)).toBe(result.heightData[i]);
      }
    } finally {
      result.geometry.dispose();
    }
  });

  it("returns final Float32 main-grid heights without mutating worker data or including skirts", () => {
    const worker = generateQuadChunkDataSync(
      0,
      0,
      8,
      5,
      new AnalyticTerrain(plane),
    );
    const originalHeights = worker.heightData.slice();
    const terrain = new AnalyticTerrain(plane, (x, z) =>
      Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 28.419301523097687 : null,
    );
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      expect(result.heightData).not.toBe(worker.heightData);
      expect(worker.heightData).toEqual(originalHeights);
      expect(result.heightData.length).toBe(25);
      const positions = result.geometry.getAttribute("position");
      expect(positions.count).toBe(25 + 5 * 4);
      for (let i = 0; i < result.heightData.length; i++) {
        expect(positions.getY(i)).toBe(result.heightData[i]);
      }
      expect(result.heightData[12]).toBe(Math.fround(28.419301523097687));
      expect(result.heightData[0]).toBe(originalHeights[0]);
      for (let ix = 0; ix < 5; ix++) {
        expect(positions.getY(25 + ix)).toBe(
          Math.fround(result.heightData[ix] - 3),
        );
      }
      expect(terrain.heightSamples).toBe(4 * 5);
      expect(terrain.gradingSamples).toBe(5 * 5);
    } finally {
      result.geometry.dispose();
    }
  });

  it("keeps full plane gradients at every edge/corner and across adjacent chunks", () => {
    const terrain = new AnalyticTerrain(plane, plane);
    const expectedLength = Math.hypot(-0.75, 1, 0.25);
    const expected = [-0.75, 1, 0.25].map((value) => value / expectedLength);
    const results = [-4, 4].map((centerX) => {
      const worker = generateQuadChunkDataSync(centerX, 0, 8, 5, terrain);
      const before = terrain.heightSamples;
      const result = assembleQuadChunkGeometry(worker, terrain, 3);
      expect(terrain.heightSamples - before).toBe(4 * 5);
      return result;
    });
    try {
      for (const result of results) {
        const normals = result.geometry.getAttribute("normal");
        for (let i = 0; i < normals.count; i++) {
          expect(normals.getX(i)).toBeCloseTo(expected[0], 6);
          expect(normals.getY(i)).toBeCloseTo(expected[1], 6);
          expect(normals.getZ(i)).toBeCloseTo(expected[2], 6);
        }
      }
      for (let iz = 0; iz < 5; iz++) {
        expect(results[0].heightData[iz * 5 + 4]).toBe(
          results[1].heightData[iz * 5],
        );
      }
    } finally {
      for (const result of results) result.geometry.dispose();
    }
  });

  it("uses the same Float32 height precision in boundary and interior normal samples", () => {
    const field: HeightField = (x, z) =>
      28.419301523097687 + x * 0.71387913 - z * 0.29735597;
    const terrain = new AnalyticTerrain(field, field);
    const worker = generateQuadChunkDataSync(0, 0, 8, 5, terrain);
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      const normals = result.geometry.getAttribute("normal");
      for (let iz = 0; iz < 5; iz++) {
        for (let ix = 0; ix < 5; ix++) {
          const x = -4 + ix * 2;
          const z = -4 + iz * 2;
          const nx =
            -(Math.fround(field(x + 2, z)) - Math.fround(field(x - 2, z))) / 4;
          const nz =
            -(Math.fround(field(x, z + 2)) - Math.fround(field(x, z - 2))) / 4;
          const length = Math.sqrt(nx * nx + 1 + nz * nz);
          const index = iz * 5 + ix;
          expect(normals.getX(index)).toBe(Math.fround(nx / length));
          expect(normals.getY(index)).toBe(Math.fround(1 / length));
          expect(normals.getZ(index)).toBe(Math.fround(nz / length));
        }
      }
    } finally {
      result.geometry.dispose();
    }
  });

  it("matches shared-edge normals when only the neighboring chunk contains graded vertices", () => {
    const raw = new AnalyticTerrain(() => 22);
    const graded = new AnalyticTerrain(
      () => 22,
      (x) => (x <= -1 ? 24 : null),
    );
    const workers = [-4, 4].map((x) =>
      generateQuadChunkDataSync(x, 0, 8, 5, raw),
    );
    const results = workers.map((worker) =>
      assembleQuadChunkGeometry(worker, graded, 3),
    );
    try {
      expect(results[0].heightData).not.toBe(workers[0].heightData);
      expect(results[1].heightData).toBe(workers[1].heightData);
      expect(graded.heightSamples).toBe(2 * 4 * 5);
      const leftNormals = results[0].geometry.getAttribute("normal");
      const rightNormals = results[1].geometry.getAttribute("normal");
      for (let iz = 0; iz < 5; iz++) {
        const left = iz * 5 + 4;
        const right = iz * 5;
        expect(results[0].heightData[left]).toBe(22);
        expect(results[1].heightData[right]).toBe(22);
        expect(leftNormals.getX(left)).toBeGreaterThan(0);
        expect(rightNormals.getX(right)).toBe(leftNormals.getX(left));
        expect(rightNormals.getY(right)).toBe(leftNormals.getY(left));
        expect(rightNormals.getZ(right)).toBe(leftNormals.getZ(left));
      }
    } finally {
      for (const result of results) result.geometry.dispose();
    }
  });

  it.each([5, 16, 64])(
    "bounds the worst-case border-only grading check at resolution %i without changing main-grid heights",
    (resolution) => {
      const step = 8 / (resolution - 1);
      const raw = new AnalyticTerrain(() => 22);
      const worker = generateQuadChunkDataSync(0, 0, 8, resolution, raw);
      const terrain = new AnalyticTerrain(
        () => 22,
        // Only the final sample in the four-sided border scan is graded.
        (x, z) => (x === 4 && z === 4 + step ? 26 : null),
      );
      const result = assembleQuadChunkGeometry(worker, terrain, 3);
      try {
        expect(result.heightData).toBe(worker.heightData);
        expect([...result.heightData].every((height) => height === 22)).toBe(
          true,
        );
        expect(terrain.gradingSamples).toBe(
          resolution * resolution + 4 * resolution,
        );
        expect(terrain.heightSamples).toBe(4 * resolution);
        const normals = result.geometry.getAttribute("normal");
        const index = resolution * resolution - 1;
        const slope = 2 / step;
        const length = Math.sqrt(1 + slope * slope);
        expect(normals.getX(index)).toBeCloseTo(0, 12);
        expect(normals.getY(index)).toBe(Math.fround(1 / length));
        expect(normals.getZ(index)).toBe(Math.fround(-slope / length));
      } finally {
        result.geometry.dispose();
      }
    },
  );
});

describe("feature-conforming authoritative floor collars", () => {
  const grade = getDuelArenaGradeHeight();
  const floors = createDuelArenaFloorZones(getDuelArenaConfig(), grade);
  const features = floors.map((zone) => ({
    minX: zone.centerX - zone.width / 2,
    maxX: zone.centerX + zone.width / 2,
    minZ: zone.centerZ - zone.depth / 2,
    maxZ: zone.centerZ + zone.depth / 2,
    blendRadius: zone.blendRadius,
  }));
  const floorHeight: GradingField = (x, z) => {
    for (const floor of floors) {
      const height = resolveDuelArenaFloorHeight(floor, x, z, grade);
      if (height !== null) return height;
    }
    return null;
  };
  const canonical = (x: number, z: number) => floorHeight(x, z) ?? grade;

  it.each([64, 128])(
    "resumes exact sync/assembly bytes with bounded provider batches at resolution %i",
    (resolution) => {
      const bytes = (array: ArrayBufferView) =>
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      const prepare = () =>
        new AnalyticTerrain(() => grade, floorHeight, features);
      const syncProvider = prepare(),
        stepProvider = prepare();
      const receipt = new Map<string, { calls: number; maxMs: number }>();
      const drain = <T>(
        steps: Generator<string, T, void>,
        maxHeights: number,
      ): T => {
        let count = 0;
        for (;;) {
          const before = [
            stepProvider.heightSamples,
            stepProvider.gradingSamples,
            stepProvider.roadSamples,
            stepProvider.biomeSamples,
          ];
          const start = performance.now();
          const next = steps.next();
          const elapsed = performance.now() - start;
          expect(stepProvider.heightSamples - before[0]).toBeLessThanOrEqual(
            maxHeights,
          );
          expect(stepProvider.gradingSamples - before[1]).toBeLessThanOrEqual(
            64,
          );
          expect(stepProvider.roadSamples - before[2]).toBeLessThanOrEqual(32);
          expect(stepProvider.biomeSamples - before[3]).toBeLessThanOrEqual(32);
          if (next.done) {
            expect(count).toBeGreaterThan(100);
            return next.value;
          }
          expect(typeof next.value).toBe("string");
          const phase = receipt.get(next.value) ?? { calls: 0, maxMs: 0 };
          phase.calls++;
          phase.maxMs = Math.max(phase.maxMs, elapsed);
          receipt.set(next.value, phase);
          count++;
        }
      };
      const syncData = generateQuadChunkDataSync(
        350,
        350,
        100,
        resolution,
        syncProvider,
      );
      const stepData = drain(
        generateQuadChunkDataSteps(350, 350, 100, resolution, stepProvider),
        32,
      );
      expect(stepData).toEqual(syncData);
      const channels = [
        "heightData",
        "normalData",
        "colorData",
        "biomeData",
        "biomeForestWeight",
        "biomeCanyonWeight",
        "riverProximity",
      ] as const;
      for (const channel of channels)
        expect(bytes(stepData[channel]!)).toEqual(bytes(syncData[channel]!));
      const before = channels.map((channel) =>
        bytes(stepData[channel]!).slice(),
      );
      const sync = assembleQuadChunkGeometry(syncData, syncProvider, 3);
      const staged = drain(
        assembleQuadChunkGeometrySteps(stepData, stepProvider, 3),
        128,
      );
      try {
        expect(bytes(staged.heightData)).toEqual(bytes(sync.heightData));
        for (const [name, attribute] of Object.entries(
          sync.geometry.attributes,
        )) {
          const actual = staged.geometry.getAttribute(name);
          expect(actual.itemSize).toBe(attribute.itemSize);
          expect(bytes(actual.array)).toEqual(bytes(attribute.array));
        }
        expect(bytes(staged.geometry.index!.array)).toEqual(
          bytes(sync.geometry.index!.array),
        );
        expect(staged.geometry.userData.terrainCellTopology).toEqual(
          sync.geometry.userData.terrainCellTopology,
        );
        expect(staged.geometry.boundingBox).toEqual(sync.geometry.boundingBox);
        expect(staged.geometry.boundingSphere).toEqual(
          sync.geometry.boundingSphere,
        );
        expect(
          Object.isFrozen(staged.geometry.userData.terrainCellTopology),
        ).toBe(true);
        for (const [i, channel] of channels.entries())
          expect(bytes(stepData[channel]!)).toEqual(before[i]);
        for (const field of [
          "heightSamples",
          "gradingSamples",
          "roadSamples",
          "biomeSamples",
        ] as const)
          expect(stepProvider[field]).toBe(syncProvider[field]);
        for (const phase of [
          "sync_height_samples",
          "sync_normals",
          "sync_biomes",
          "assembly_grid_vertices",
          "assembly_grid_normals",
          "assembly_grid_indices",
          "collar_partition",
          "collar_polygon_indices",
          "collar_vertex_attributes",
          "collar_vertex_normals",
          "collar_boundary_normals",
          "assembly_bounding_sphere",
        ])
          expect(receipt.has(phase), phase).toBe(true);
        process.stdout.write(
          `Terrain preparation steps ${JSON.stringify({
            resolution,
            phases: Object.fromEntries(receipt),
            nativeOrPerformanceAcceptance: false,
          })}\n`,
        );
      } finally {
        sync.geometry.dispose();
        staged.geometry.dispose();
      }
    },
  );

  it("disposes only private unreturned geometry when cancelled or failed at preparation boundaries", () => {
    const worker = generateQuadChunkDataSync(
      350,
      350,
      100,
      64,
      new AnalyticTerrain(() => grade, floorHeight, features),
    );
    const before = worker.heightData.slice();
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    try {
      for (const phase of [
        "assembly_allocate_grid",
        "assembly_geometry_attributes",
        "collar_partition",
        "collar_install_attributes",
        "assembly_bounding_sphere",
      ]) {
        const provider = new AnalyticTerrain(
          () => grade,
          floorHeight,
          features,
        );
        const iterator = assembleQuadChunkGeometrySteps(worker, provider, 3);
        let step = iterator.next();
        while (!step.done && step.value !== phase) step = iterator.next();
        expect(step.done).toBe(false);
        const previous = dispose.mock.calls.length;
        expect(iterator.return(undefined as never)).toEqual({
          done: true,
          value: undefined,
        });
        expect(dispose.mock.calls.length - previous).toBe(
          phase === "assembly_allocate_grid" ? 0 : 1,
        );
        const queries = provider.heightSamples;
        expect(iterator.next()).toEqual({ done: true, value: undefined });
        expect(provider.heightSamples).toBe(queries);
        expect(worker.heightData).toEqual(before);
      }
      const badProvider = new AnalyticTerrain(() => grade, floorHeight, [
        { ...features[0], blendRadius: 0 },
      ]);
      const bad = assembleQuadChunkGeometrySteps(worker, badProvider, 3);
      let step = bad.next();
      while (!step.done && step.value !== "assembly_geometry_attributes")
        step = bad.next();
      const previous = dispose.mock.calls.length;
      expect(() => bad.next()).toThrow(
        "Invalid terrain collar refinement feature",
      );
      expect(dispose.mock.calls.length).toBe(previous + 1);
      expect(bad.next().done).toBe(true);

      const dataProvider = new AnalyticTerrain(plane);
      const data = generateQuadChunkDataSteps(0, 0, 100, 128, dataProvider);
      expect(data.next().value).toBe("sync_allocate_heights");
      expect(data.next().value).toBe("sync_height_samples");
      const queries = dataProvider.heightSamples;
      expect(data.return(undefined as never)).toEqual({
        done: true,
        value: undefined,
      });
      expect(data.next().done).toBe(true);
      expect(dataProvider.heightSamples).toBe(queries);
    } finally {
      dispose.mockRestore();
    }
  });

  it("retains exact original buffers and queries when the optional features are absent, empty or outside the chunk", () => {
    const worker = generateQuadChunkDataSync(
      0,
      0,
      100,
      64,
      new AnalyticTerrain(plane),
    );
    const results = [undefined, [], features].map((zones) => {
      const provider = new AnalyticTerrain(plane, () => null, zones);
      const result = assembleQuadChunkGeometry(worker, provider, 3);
      expect(provider.heightSamples).toBe(0);
      expect(result.geometry.userData.terrainCellTopology).toBeUndefined();
      return result;
    });
    try {
      for (const next of results.slice(1)) {
        for (const name of Object.keys(results[0].geometry.attributes))
          expect(next.geometry.getAttribute(name).array).toEqual(
            results[0].geometry.getAttribute(name).array,
          );
        expect(next.geometry.index!.array).toEqual(
          results[0].geometry.index!.array,
        );
      }
    } finally {
      results.forEach((result) => result.geometry.dispose());
    }
  });

  it.each([0, -0.25])(
    "matches both neighbours' normals and skirt copies when a floor collar only touches or lies just beyond their shared boundary (%s m)",
    (delta) => {
      const boundaryX = features[0].minX - features[0].blendRadius + delta;
      const resolution = 64;
      // Isolate the actual arena floor: the separate hospital begins farther
      // west and would otherwise legitimately refine the alleged outside leaf.
      const isolatedGrade: GradingField = (x, z) =>
        resolveDuelArenaFloorHeight(floors[0], x, z, grade);
      const terrain = new AnalyticTerrain(() => grade, isolatedGrade, [
        features[0],
      ]);
      const results = [boundaryX - 50, boundaryX + 50].map((centerX) => {
        const worker = generateQuadChunkDataSync(
          centerX,
          406,
          100,
          resolution,
          terrain,
        );
        return { centerX, ...assembleQuadChunkGeometry(worker, terrain, 3) };
      });
      const plain = assembleQuadChunkGeometry(
        generateQuadChunkDataSync(
          boundaryX - 50,
          406,
          100,
          resolution,
          new AnalyticTerrain(() => grade, isolatedGrade),
        ),
        new AnalyticTerrain(() => grade, isolatedGrade),
        3,
      );
      try {
        expect(
          results[0].geometry.userData.terrainCellTopology,
        ).toBeUndefined();
        expect(results[1].geometry.userData.terrainCellTopology).toBeDefined();
        expect(results[0].geometry.getAttribute("position").array).toEqual(
          plain.geometry.getAttribute("position").array,
        );
        expect(results[0].geometry.index!.array).toEqual(
          plain.geometry.index!.array,
        );
        const left = results[0].geometry.getAttribute("normal"),
          right = results[1].geometry.getAttribute("normal");
        for (let iz = 0; iz < resolution; iz++) {
          const a = iz * resolution + resolution - 1,
            b = iz * resolution;
          expect(left.getX(a)).toBe(right.getX(b));
          expect(left.getY(a)).toBe(right.getY(b));
          expect(left.getZ(a)).toBe(right.getZ(b));
        }
        const p = results[0].geometry.getAttribute("position");
        const shared = new Map<number, number>();
        for (let iz = 0; iz < resolution; iz++)
          shared.set(
            p.getZ(iz * resolution + resolution - 1),
            iz * resolution + resolution - 1,
          );
        for (let id = resolution * resolution; id < p.count; id++)
          if (p.getX(id) === 50) {
            const main = shared.get(p.getZ(id));
            if (main === undefined)
              throw new Error(
                "Skirt missing an actual shared-edge main vertex",
              );
            expect(left.getX(id)).toBe(left.getX(main));
            expect(left.getY(id)).toBe(left.getY(main));
            expect(left.getZ(id)).toBe(left.getZ(main));
          }
      } finally {
        results.forEach((result) => result.geometry.dispose());
        plain.geometry.dispose();
      }
    },
  );

  it.each([64, 128])(
    "keeps all original grid positions and produces closed non-overlapping cells, attributes and skirts at resolution %i",
    (resolution) => {
      const provider = new AnalyticTerrain(() => grade, floorHeight, features);
      const worker = generateQuadChunkDataSync(
        350,
        350,
        100,
        resolution,
        provider,
      );
      const baseline = assembleQuadChunkGeometry(
        worker,
        new AnalyticTerrain(() => grade, floorHeight),
        3,
      );
      const before = provider.heightSamples,
        started = performance.now();
      const result = assembleQuadChunkGeometry(worker, provider, 3);
      const elapsedMs = performance.now() - started;
      try {
        const geometry = result.geometry,
          p = geometry.getAttribute("position"),
          index = geometry.index!;
        const topology = geometry.userData.terrainCellTopology as {
          schemaVersion: number;
          resolution: number;
          surfaceVertexCount: number;
          cellIndexOffsets: readonly number[];
        };
        expect(Object.isFrozen(topology)).toBe(true);
        expect(Object.isFrozen(topology.cellIndexOffsets)).toBe(true);
        expect(topology.schemaVersion).toBe(1);
        expect(topology.resolution).toBe(resolution);
        expect(topology.cellIndexOffsets.length).toBe(
          (resolution - 1) ** 2 + 1,
        );
        expect(topology.cellIndexOffsets[0]).toBe(0);
        expect(
          (p.array as Float32Array).subarray(0, resolution * resolution * 3),
        ).toEqual(
          (
            baseline.geometry.getAttribute("position").array as Float32Array
          ).subarray(0, resolution * resolution * 3),
        );
        expect(result.heightData).toEqual(baseline.heightData);
        const edges = new Map<
          string,
          { a: number; b: number; count: number; direction: number }
        >();
        let maxFaces = 0;
        for (
          let cell = 0;
          cell < topology.cellIndexOffsets.length - 1;
          cell++
        ) {
          const begin = topology.cellIndexOffsets[cell],
            end = topology.cellIndexOffsets[cell + 1];
          const iz = Math.floor(cell / (resolution - 1)),
            ix = cell % (resolution - 1),
            a = iz * resolution + ix;
          const x0 = p.getX(a),
            x1 = p.getX(a + 1),
            z0 = p.getZ(a),
            z1 = p.getZ(a + resolution);
          let area = 0;
          maxFaces = Math.max(maxFaces, (end - begin) / 3);
          expect(begin % 3).toBe(0);
          expect((end - begin) / 3).toBeLessThanOrEqual(512);
          for (let i = begin; i < end; i += 3) {
            const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
            for (const id of ids) {
              expect(id).toBeLessThan(topology.surfaceVertexCount);
              expect(p.getX(id)).toBeGreaterThanOrEqual(x0);
              expect(p.getX(id)).toBeLessThanOrEqual(x1);
              expect(p.getZ(id)).toBeGreaterThanOrEqual(z0);
              expect(p.getZ(id)).toBeLessThanOrEqual(z1);
            }
            const [u, v, w] = ids;
            const signed =
              (p.getX(v) - p.getX(u)) * (p.getZ(w) - p.getZ(u)) -
              (p.getZ(v) - p.getZ(u)) * (p.getX(w) - p.getX(u));
            expect(signed).toBeLessThan(0);
            area -= signed / 2;
            for (let e = 0; e < 3; e++) {
              const a = ids[e],
                b = ids[(e + 1) % 3],
                key = a < b ? `${a},${b}` : `${b},${a}`;
              const edge = edges.get(key) ?? { a, b, count: 0, direction: 0 };
              edge.count++;
              edge.direction += a < b ? 1 : -1;
              edges.set(key, edge);
            }
          }
          expect(area).toBeCloseTo((x1 - x0) * (z1 - z0), 7);
        }
        let outer = 0;
        for (const edge of edges.values()) {
          const boundary =
            (p.getX(edge.a) === -50 && p.getX(edge.b) === -50) ||
            (p.getX(edge.a) === 50 && p.getX(edge.b) === 50) ||
            (p.getZ(edge.a) === -50 && p.getZ(edge.b) === -50) ||
            (p.getZ(edge.a) === 50 && p.getZ(edge.b) === 50);
          expect(edge.count).toBe(boundary ? 1 : 2);
          if (boundary) outer++;
          else expect(edge.direction).toBe(0);
        }
        const mainIndices =
          topology.cellIndexOffsets[topology.cellIndexOffsets.length - 1];
        expect(index.count - mainIndices).toBe(outer * 6);
        expect(p.count - topology.surfaceVertexCount).toBe(outer + 4);
        for (const [name, attribute] of Object.entries(geometry.attributes)) {
          expect(attribute.count, name).toBe(p.count);
          expect(Array.from(attribute.array).every(Number.isFinite), name).toBe(
            true,
          );
        }
        process.stdout.write(
          `Floor collar geometry ${JSON.stringify({
            resolution,
            elapsedMs,
            heightQueries: provider.heightSamples - before,
            originalVertices: baseline.geometry.getAttribute("position").count,
            vertices: p.count,
            originalTriangles: baseline.geometry.index!.count / 3,
            triangles: index.count / 3,
            addedSurfaceVertices:
              topology.surfaceVertexCount - resolution * resolution,
            offsetNumericBytes: topology.cellIndexOffsets.length * 8,
            maxFaces,
            nativeOrPerformanceAcceptance: false,
          })}\n`,
        );
      } finally {
        baseline.geometry.dispose();
        result.geometry.dispose();
      }
    },
  );

  it("rejects invalid feature data and excessive feature counts without mutating worker output", () => {
    const raw = new AnalyticTerrain(() => grade),
      worker = generateQuadChunkDataSync(350, 350, 100, 64, raw);
    const saved = worker.heightData.slice();
    for (const zones of [
      [{ ...features[0], blendRadius: 0 }],
      [{ ...features[0], minX: NaN }],
      Array.from({ length: 17 }, () => features[0]),
    ]) {
      expect(() =>
        assembleQuadChunkGeometry(
          worker,
          new AnalyticTerrain(() => grade, floorHeight, zones),
          3,
        ),
      ).toThrow();
      expect(worker.heightData).toEqual(saved);
    }
  });

  it("matches actual downward Three raycasts and one-sided normals at every floor's unchanged square-collar corner crease", () => {
    const terrain = new AnalyticTerrain(() => grade, floorHeight, features);
    const worker = generateQuadChunkDataSync(350, 400, 100, 64, terrain);
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(result.geometry, material);
    mesh.position.set(350, 0, 400);
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(),
      origin = new THREE.Vector3(),
      down = new THREE.Vector3(0, -1, 0);
    let worstHeight = 0,
      worstNormal = 0,
      count = 0;
    try {
      for (const floor of floors)
        for (const sx of [-1, 1])
          for (const sz of [-1, 1])
            for (const distance of [0.25, 0.5, 0.75])
              for (const side of ["crease", "x", "z"]) {
                const dx = side === "z" ? distance / 2 : distance;
                const dz = side === "x" ? distance / 2 : distance;
                const x = floor.centerX + sx * (floor.width / 2 + dx);
                const z = floor.centerZ + sz * (floor.depth / 2 + dz);
                origin.set(x, grade + 10, z);
                ray.set(origin, down);
                const hit = ray.intersectObject(mesh, false)[0];
                expect(hit).toBeDefined();
                const error = Math.abs(hit.point.y - canonical(x, z));
                worstHeight = Math.max(worstHeight, error);
                expect(error).toBeLessThan(0.05);
                if (!hit.face)
                  throw new Error("Raycast returned no actual terrain face");
                const t = distance / floor.blendRadius;
                const slope =
                  ((floor.height - grade) * 6 * t * (1 - t)) /
                  floor.blendRadius;
                const xNormal = new THREE.Vector3(sx * slope, 1, 0).normalize();
                const zNormal = new THREE.Vector3(0, 1, sz * slope).normalize();
                // At the max-axis diagonal, the canonical surface has TWO one-sided
                // normals, not their centred-difference average. Preserve the crease.
                const dot =
                  side === "x"
                    ? hit.face.normal.dot(xNormal)
                    : side === "z"
                      ? hit.face.normal.dot(zNormal)
                      : Math.max(
                          hit.face.normal.dot(xNormal),
                          hit.face.normal.dot(zNormal),
                        );
                const angle =
                  (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
                worstNormal = Math.max(worstNormal, angle);
                expect(angle).toBeLessThan(10);
                count++;
              }
      expect(count).toBe(108);
      process.stdout.write(
        `Floor collar raycasts ${JSON.stringify({ count, worstHeight, worstNormal, nativeOrGameplayAcceptance: false })}\n`,
      );
    } finally {
      material.dispose();
      result.geometry.dispose();
    }
  });

  it("covers the actual arena z400 seam with segmented skirts on adjacent 128/64 leaves without claiming to eliminate inherited unequal-LOD grid junctions", () => {
    const terrain = new AnalyticTerrain(() => grade, floorHeight, features);
    const results = [
      { centerZ: 350, resolution: 128 },
      { centerZ: 450, resolution: 64 },
    ].map((spec) => ({
      ...spec,
      ...assembleQuadChunkGeometry(
        generateQuadChunkDataSync(
          350,
          spec.centerZ,
          100,
          spec.resolution,
          terrain,
        ),
        terrain,
        3,
      ),
    }));
    try {
      const edges = results.map((result, side) => {
        const geometry = result.geometry,
          p = geometry.getAttribute("position"),
          index = geometry.index!;
        const topology = geometry.userData.terrainCellTopology as {
          surfaceVertexCount: number;
          cellIndexOffsets: readonly number[];
        };
        const z = side === 0 ? 50 : -50;
        const points: { id: number; x: number; y: number }[] = [];
        for (let id = 0; id < topology.surfaceVertexCount; id++)
          if (p.getZ(id) === z)
            points.push({ id, x: p.getX(id), y: p.getY(id) });
        points.sort((a, b) => a.x - b.x);
        const covered = new Set<string>();
        const mainEnd =
          topology.cellIndexOffsets[topology.cellIndexOffsets.length - 1];
        for (let i = mainEnd; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          if (!ids.every((id) => p.getZ(id) === z)) continue;
          const top = ids.filter((id) => id < topology.surfaceVertexCount);
          if (top.length === 2)
            covered.add(
              top[0] < top[1] ? `${top[0]},${top[1]}` : `${top[1]},${top[0]}`,
            );
        }
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i].id,
            b = points[i + 1].id;
          expect(covered.has(a < b ? `${a},${b}` : `${b},${a}`)).toBe(true);
        }
        const arena = features[0];
        for (let k = 0; k <= 8; k++)
          for (const x of [arena.minX - 350 - k / 8, arena.maxX - 350 + k / 8])
            expect(points.some((point) => point.x === Math.fround(x))).toBe(
              true,
            );
        return points;
      });
      const at = (points: (typeof edges)[number], x: number) => {
        const right = points.findIndex((point) => point.x >= x);
        if (right <= 0) return points[0].y;
        const a = points[right - 1],
          b = points[right];
        return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
      };
      const knots = [
        ...new Set(edges.flatMap((points) => points.map((point) => point.x))),
      ].sort((a, b) => a - b);
      let worstGap = 0,
        worstError = 0;
      for (let i = 0; i < knots.length - 1; i++)
        for (const x of [knots[i], (knots[i] + knots[i + 1]) / 2]) {
          const left = at(edges[0], x),
            right = at(edges[1], x);
          worstGap = Math.max(worstGap, Math.abs(left - right));
          worstError = Math.max(
            worstError,
            Math.abs(left - canonical(350 + x, 400)),
            Math.abs(right - canonical(350 + x, 400)),
          );
        }
      expect(worstGap).toBeLessThan(0.005);
      expect(worstError).toBeLessThan(0.005);
      process.stdout.write(
        `Floor collar unequalLOD seam ${JSON.stringify({ seamZ: 400, resolutions: [128, 64], edgeVertices: edges.map((edge) => edge.length), worstGap, worstError, skirtDrop: 3, inheritedLODStitchOrNativeAcceptance: false })}\n`,
      );
    } finally {
      results.forEach((result) => result.geometry.dispose());
    }
  });
});
