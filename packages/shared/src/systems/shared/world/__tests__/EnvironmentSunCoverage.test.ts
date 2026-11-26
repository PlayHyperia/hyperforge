import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import THREE from "../../../../extras/three/three";
import type { WorldConfigManifest } from "../../../../types/world/world-types";
import { ClientInterface } from "../../../client/ClientInterface";
import { Environment } from "../Environment";
import { sampleSkyCycle } from "../SkySystem";
import { TerrainSystem } from "../TerrainSystem";
import { worldTerrainProfileIdentity } from "../WorldTerrainProfile";

const TERRAIN_STEP = 2;
const CASTER_STEP = 16;
const CASTER_HEIGHT = 32;
const CASTER_HALF_WIDTH = 3;
const CLIP_TOLERANCE = 1e-10;

type SurfacePoint = readonly [number, number, number];
type SampleSet = {
  kind: "above-sea terrain" | "representative tall caster boxes";
  points: SurfacePoint[];
};

// Actual sky-cycle rays, with additional azimuth rotations for coverage stress.
// These rotations are not a claim that the authored sky visits every bearing.
const phases = [
  { label: "low sun", phase: 0.26, moon: false },
  { label: "day sun", phase: 0.42, moon: false },
  { label: "noon sun", phase: 0.5, moon: false },
  { label: "moon", phase: 0, moon: true },
  { label: "low moon", phase: 0.24, moon: true },
] as const;
const directions = phases.flatMap((phase) =>
  [0, 45, 90, 135, 180, 225, 270, 315].map((azimuth) => ({
    ...phase,
    azimuth,
  })),
);

/** CPU projection coverage only. Real manifest, terrain lease, Environment and
 * Three shadow matrices; no renderer, shadow-map allocation or GPU surrogate.
 * The 2 m lattice covers sampled above-sea ground across the entire nominal
 * island envelope. The boxes are explicit representative 32 m casters, not a
 * census or certification of every mesh, between-sample terrain, ocean receiver,
 * animated vertex, shadow filter, normal bias or long projected ground shadow.
 */
describe("compact directional shadow CPU coverage envelope", () => {
  let world: World;
  let terrain: TerrainSystem;
  let environment: Environment;
  let light: THREE.DirectionalLight;
  let surface: ReturnType<TerrainSystem["captureCanonicalGroundLease"]>;
  let anchor: THREE.Vector3;
  const terrainSamples: SampleSet = { kind: "above-sea terrain", points: [] };
  const casterSamples: SampleSet = {
    kind: "representative tall caster boxes",
    points: [],
  };
  const sampleSets = [terrainSamples, casterSamples];
  let casterCount = 0;
  let wetSamplesExcluded = 0;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalCsm = process.env.ENABLE_CSM;

  beforeAll(async () => {
    // Run terrain's actual Node/CPU path before providing the browser presence
    // required by Environment.init. No graphics system is registered or started.
    Reflect.deleteProperty(globalThis, "window");
    process.env.ENABLE_CSM = "false";
    await DataManager.getInstance().initialize();
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../server/world/assets/manifests/world-config.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as WorldConfigManifest;
    DataManager.setWorldConfig(manifest);
    world = new World();
    terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
    surface = terrain.captureCanonicalGroundLease();
    expect(surface.profile.kind).toBe("compact-candidate");
    expect(surface.supportBounds.length).toBeGreaterThan(0);
    expect(surface.isCurrent()).toBe(true);

    const { bounds, island, height, water } = surface.profile;
    anchor = new THREE.Vector3(
      island.centerX,
      height.baseOffset,
      island.centerZ,
    );
    for (let z = bounds.minZ; z <= bounds.maxZ; z += TERRAIN_STEP) {
      for (let x = bounds.minX; x <= bounds.maxX; x += TERRAIN_STEP) {
        const y = surface.sampleHeight(x, z);
        if (!Number.isFinite(y))
          throw new Error(`Non-finite terrain at ${x},${z}`);
        if (y < water.threshold) {
          wetSamplesExcluded++;
          continue;
        }
        terrainSamples.points.push([x, y, z]);
      }
    }
    for (let z = bounds.minZ; z <= bounds.maxZ; z += CASTER_STEP) {
      for (let x = bounds.minX; x <= bounds.maxX; x += CASTER_STEP) {
        const y = surface.sampleHeight(x, z);
        if (y < water.threshold) continue;
        const corners = [-CASTER_HALF_WIDTH, CASTER_HALF_WIDTH].flatMap((dx) =>
          [-CASTER_HALF_WIDTH, CASTER_HALF_WIDTH].map(
            (dz) =>
              [x + dx, surface.sampleHeight(x + dx, z + dz), z + dz] as const,
          ),
        );
        const bottom = Math.min(y, ...corners.map((point) => point[1]));
        const top =
          Math.max(y, ...corners.map((point) => point[1])) + CASTER_HEIGHT;
        for (const [cornerX, , cornerZ] of corners) {
          casterSamples.points.push(
            [cornerX, bottom, cornerZ],
            [cornerX, top, cornerZ],
          );
        }
        casterCount++;
      }
    }

    // Browser presence is configuration only; all world/light owners stay real.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    const prefs = new ClientInterface(world);
    world.addSystem("prefs", prefs);
    prefs.shadows = "med";
    environment = world.register("environment", Environment) as Environment;
    await environment.init({});
    environment.buildSunLight();
    if (!environment.sunLight)
      throw new Error("Actual compact sun was not built");
    light = environment.sunLight;
    expect(environment.getSunLightTerrainProfileIdentity()).toBe(
      worldTerrainProfileIdentity(surface.profile),
    );
    // This is the coordinate-system setup the actual WebGPU renderer applies.
    light.shadow.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    light.shadow.camera.updateProjectionMatrix();
  });

  afterAll(() => {
    try {
      world?.destroy();
    } finally {
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalCsm === undefined) delete process.env.ENABLE_CSM;
      else process.env.ENABLE_CSM = originalCsm;
    }
  });

  it("samples the admitted island rather than a hand-picked camera patch", () => {
    expect(terrainSamples.points.length).toBeGreaterThan(10_000);
    expect(wetSamplesExcluded).toBeGreaterThan(1_000);
    expect(casterCount).toBeGreaterThan(100);
    expect(casterSamples.points).toHaveLength(casterCount * 8);
    const { centerX, centerZ, radius } = surface.profile.island;
    for (const [axis, center] of [
      [0, centerX],
      [2, centerZ],
    ] as const) {
      expect(
        terrainSamples.points.some(
          (point) => point[axis] < center - radius * 0.7,
        ),
      ).toBe(true);
      expect(
        terrainSamples.points.some(
          (point) => point[axis] > center + radius * 0.7,
        ),
      ).toBe(true);
    }
    expect(light.shadow.camera).toMatchObject({
      near: 0.5,
      far: 600,
      left: -200,
      right: 200,
      top: 200,
      bottom: -200,
      coordinateSystem: THREE.WebGPUCoordinateSystem,
    });
    expect(light.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    expect(light.shadow.map).toBeNull();
  });

  it.each(directions)(
    "contains sampled ground and tall casters for $label with $azimuth degree azimuth rotation",
    ({ phase, moon, azimuth }) => {
      expect(surface.isCurrent()).toBe(true);
      const toLight = new THREE.Vector3();
      sampleSkyCycle(phase, toLight);
      if (moon) toLight.negate();
      toLight.applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(azimuth),
      );
      expect(toLight.y).toBeGreaterThan(0);
      environment.lightDirection.copy(toLight).negate();
      environment["updateSunLightPosition"]();
      expect(light.target.position.toArray()).toEqual(anchor.toArray());
      expect(light.position.distanceTo(anchor)).toBeCloseTo(400, 10);
      light.updateMatrixWorld(true);
      light.target.updateMatrixWorld(true);
      light.shadow.updateMatrices(light);
      const camera = light.shadow.camera;
      const projection = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      const clip = new THREE.Vector4();
      const shadow = new THREE.Vector3();
      for (const samples of sampleSets) {
        let worst = -Infinity;
        let worstPoint: SurfacePoint | undefined;
        let worstClip: number[] = [];
        let maxMappingError = 0;
        for (const point of samples.points) {
          clip.set(point[0], point[1], point[2], 1).applyMatrix4(projection);
          if (
            ![clip.x, clip.y, clip.z, clip.w].every(Number.isFinite) ||
            clip.w <= 0
          )
            throw new Error(
              `Invalid actual shadow clip for ${samples.kind}: ${point}`,
            );
          const x = clip.x / clip.w,
            y = clip.y / clip.w,
            z = clip.z / clip.w;
          // WebGPU clip depth is [0,1], not the legacy [-1,1] interval.
          const outside = Math.max(Math.abs(x) - 1, Math.abs(y) - 1, -z, z - 1);
          if (outside > worst) {
            worst = outside;
            worstPoint = point;
            worstClip = [x, y, z];
          }
          shadow.fromArray(point).applyMatrix4(light.shadow.matrix);
          maxMappingError = Math.max(
            maxMappingError,
            Math.abs(shadow.x - (x * 0.5 + 0.5)),
            Math.abs(shadow.y - (y * 0.5 + 0.5)),
            Math.abs(shadow.z - z),
          );
        }
        expect(
          worst,
          `${samples.kind}: ${JSON.stringify({ phase, moon, azimuth, worstPoint, worstClip, outside: worst })}`,
        ).toBeLessThanOrEqual(CLIP_TOLERANCE);
        expect(maxMappingError).toBeLessThan(CLIP_TOLERANCE);
      }
      expect(light.shadow.map).toBeNull();
    },
  );
});
