import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import {
  createCompactIslandLandform,
  createCompactSouthernMeadow,
  type CompactSouthernMeadow,
} from "../CompactIslandLandform";
import {
  adjustShorelineHeight,
  computeBaseHeight,
  computeIslandMask,
} from "../TerrainHeightParams";
import {
  buildTerrainWorkerProfileGuardJS,
  createTerrainWorkerConfig,
} from "../../../../utils/workers/TerrainWorkerShared";
import {
  TERRAIN_WORKER_CODE,
  type TerrainWorkerInput,
  type TerrainWorkerOutput,
} from "../../../../utils/workers/TerrainWorker";
import worldConfig from "../../../../../../server/world/assets/manifests/world-config.json";
import {
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE as sculpted,
  COMPACT_WORLD_TERRAIN_PROFILE as blockout,
  deserializeWorldTerrainProfile,
  resolveWorldTerrainProfile,
  serializeWorldTerrainProfile,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

const landform = createCompactIslandLandform();
const noise = new NoiseGenerator(sculpted.seed);
const height = (x: number, z: number) => landform.height(x, z, noise, sculpted);

// Trial art-direction values, not an implicit runtime selection or approval.
const meadowRecipe: CompactSouthernMeadow = {
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
};
// Retain all current bay/Haven data, independently omitting only this option.
const meadowBaseline = validateWorldTerrainProfile(
  Object.fromEntries(
    Object.entries(worldConfig.terrainProfile).filter(
      ([key]) => key !== "southernMeadow",
    ),
  ),
);
const meadowCandidate = validateWorldTerrainProfile({
  ...meadowBaseline,
  southernMeadow: meadowRecipe,
});
// Detached world04 trial. Reuse existing admission/worker controls; no new
// algorithm, default activation, noise octave or texture-dependent geometry.
const world04Candidate = validateWorldTerrainProfile({
  ...meadowCandidate,
  coastalApron: {
    ...meadowCandidate.coastalApron!,
    lowland: { ...meadowCandidate.coastalApron!.lowland!, westHoldX: 394 },
  },
  terrace: {
    ...meadowCandidate.terrace!,
    crestHeight: 17.5,
    shelfHeight: 7,
    scarpRun: 16,
    shelfWidth: 8,
    apronWidth: 30,
  },
  ridgeBreakup: {
    ...meadowCandidate.ridgeBreakup!,
    northGapZ: -20,
    northGapDepth: 0,
    southGapZ: 27,
    southGapHalfWidth: 24,
    southGapDepth: 0.5,
  },
});
// Reference-led dry head notch: not a default or a rendered art approval.
// Its scalar footprint stays west of the existing coastal approach.
const headBearing = world04Candidate.landform!.inletBearing;
const headPoint = (
  along: number,
  y: number,
): readonly [number, number, number] => [
  world04Candidate.island.centerX +
    along * Math.cos(headBearing) -
    8 * Math.sin(headBearing),
  world04Candidate.island.centerZ +
    along * Math.sin(headBearing) +
    8 * Math.cos(headBearing),
  y,
];
const headShoulderRecipe = {
  minX: 377,
  maxX: 444,
  minZ: 457,
  maxZ: 500,
  featherX: 8,
  featherZ: 4,
  start: headPoint(70, 25.4),
  end: headPoint(94, 19.2),
  leftWidth: 16,
  rightWidth: 24,
  startFade: 6,
  endFade: 8,
  leftSlope: 0.32,
  rightSlope: 0.18,
  creaseWidth: 2.4,
  blendHeight: 0.35,
};
const headShoulderCandidate = validateWorldTerrainProfile({
  ...world04Candidate,
  coastalApron: {
    ...world04Candidate.coastalApron!,
    headShoulder: headShoulderRecipe,
  },
});
const meadowNoise = new NoiseGenerator(meadowCandidate.seed);
const meadowHeight = (x: number, z: number, profile = meadowCandidate) =>
  landform.height(x, z, meadowNoise, profile);

function emittedRequest(profile: WorldTerrainProfile): TerrainWorkerInput {
  return {
    type: "generateHeightmap",
    tileX: 4,
    tileZ: 4,
    seed: profile.seed,
    biomeCenters: [],
    biomes: {},
    config: createTerrainWorkerConfig(profile, 51),
  };
}

function assertEmittedInput(input: TerrainWorkerInput): void {
  runInNewContext(
    buildTerrainWorkerProfileGuardJS() +
      "\nassertTerrainWorkerInput(JSON.parse(requestJSON));",
    { requestJSON: JSON.stringify(input) },
    { timeout: 5000 },
  );
}

function shoreHeight(x: number, z: number, p = meadowCandidate): number {
  const s = p.shoreline,
    base = meadowHeight(x, z, p);
  const d = s.SLOPE_SAMPLE_DISTANCE;
  const slope = Math.max(
    ...[
      [0, d],
      [0, -d],
      [d, 0],
      [-d, 0],
    ].map(([dx, dz]) => Math.abs(meadowHeight(x + dx, z + dz, p) - base) / d),
  );
  return adjustShorelineHeight(base, slope, {
    waterThreshold: p.water.threshold,
    shorelineLandBand: s.LAND_BAND,
    shorelineUnderwaterBand: s.UNDERWATER_BAND,
    shorelineMinSlope: s.MIN_SLOPE,
    shorelineLandMaxMultiplier: s.LAND_MAX_MULTIPLIER,
    underwaterDepthMultiplier: s.UNDERWATER_DEPTH_MULTIPLIER,
  });
}

describe("authored compact island landform", () => {
  it("admits the optional head notch through the canonical profile and emitted guard, without selecting it by default", () => {
    const serialized = serializeWorldTerrainProfile(headShoulderCandidate);
    expect(
      serializeWorldTerrainProfile(deserializeWorldTerrainProfile(serialized)),
    ).toBe(serialized);
    expect(worldTerrainProfileIdentity(headShoulderCandidate)).not.toBe(
      worldTerrainProfileIdentity(world04Candidate),
    );
    expect(world04Candidate.coastalApron).not.toHaveProperty("headShoulder");
    expect(worldConfig.terrainProfile.coastalApron).not.toHaveProperty(
      "headShoulder",
    );
    expect(() =>
      assertEmittedInput(emittedRequest(headShoulderCandidate)),
    ).not.toThrow();
    expect(() =>
      validateWorldTerrainProfile({
        ...world04Candidate,
        coastalApron: {
          ...world04Candidate.coastalApron!,
          headShoulder: { ...headShoulderRecipe, end: headPoint(94, 18.9) },
        },
      }),
    ).toThrow(/coastal head dry floor/);
    // Re-identification must not let transport bypass the dry-floor gate.
    const altered = JSON.parse(
      JSON.stringify(emittedRequest(headShoulderCandidate)),
    ) as TerrainWorkerInput;
    const raw = altered.config.TERRAIN_PROFILE as unknown as {
      coastalApron: { headShoulder: { end: [number, number, number] } };
    };
    raw.coastalApron.headShoulder.end[2] = 18.9;
    altered.config.TERRAIN_PROFILE_IDENTITY =
      "hyperia-world-terrain-profile-v1\n" +
      JSON.stringify(altered.config.TERRAIN_PROFILE);
    expect(() => assertEmittedInput(altered)).toThrow(/invalid profile/);
  });

  it("makes a metres-scale asymmetric dry head cut while preserving the old mask and sampled corrected wet ground", () => {
    let changed = 0,
      maxDrop = 0,
      wet = 0;
    let maximumDropAt: readonly [number, number] = [0, 0];
    for (let z = 456; z <= 501; z += 1)
      for (let x = 376; x <= 445; x += 1) {
        const before = meadowHeight(x, z, world04Candidate);
        const after = meadowHeight(x, z, headShoulderCandidate);
        expect(after).toBeLessThanOrEqual(before);
        if (after !== before) {
          changed++;
          if (before - after > maxDrop) {
            maxDrop = before - after;
            maximumDropAt = [x, z];
          }
          expect(after).toBeGreaterThan(headShoulderRecipe.end[2]);
        }
        expect(landform.mask(x, z, meadowNoise, headShoulderCandidate)).toBe(
          landform.mask(x, z, meadowNoise, world04Candidate),
        );
        if (before <= headShoulderRecipe.end[2]) expect(after).toBe(before);
        const beforeShore = shoreHeight(x, z, world04Candidate);
        const afterShore = shoreHeight(x, z, headShoulderCandidate);
        expect(afterShore).toBeLessThanOrEqual(beforeShore);
        if (beforeShore <= world04Candidate.water.threshold) {
          wet++;
          expect(afterShore).toBe(beforeShore);
        }
        expect(afterShore <= world04Candidate.water.threshold).toBe(
          beforeShore <= world04Candidate.water.threshold,
        );
      }
    expect(changed).toBeGreaterThan(100);
    expect(wet).toBeGreaterThan(100);
    expect(maxDrop).toBeGreaterThan(3);
    expect(maxDrop).toBeLessThan(5);
    console.info("[cove-head scalar]", {
      changedSamples: changed,
      unchangedWetSamples: wet,
      maxDrop,
      maximumDropAt,
      spacingMetres: 1,
      bounds: [376, 445, 456, 501],
    });
    // Actual shoreline/retained-cell boundaries still need a geometry review;
    // equality at scalar samples is not an interpolated waterline guarantee.
  });

  it("retains the whole downstream approach and exterior with the shoreline stencil", () => {
    for (let x = 450; x <= 466; x += 0.5)
      for (let z = 450; z <= 483; z += 0.5) {
        expect(meadowHeight(x, z, headShoulderCandidate)).toBe(
          meadowHeight(x, z, world04Candidate),
        );
        expect(shoreHeight(x, z, headShoulderCandidate)).toBe(
          shoreHeight(x, z, world04Candidate),
        );
      }
    for (let x = 365; x <= 454; x += 2)
      for (let z = 445; z <= 512; z += 2) {
        if (x >= 376 && x <= 445 && z >= 456 && z <= 501) continue;
        expect(shoreHeight(x, z, headShoulderCandidate)).toBe(
          shoreHeight(x, z, world04Candidate),
        );
      }
  });

  it("requires an explicit distinct admitted algorithm and identity", () => {
    expect(sculpted.algorithm).toBe("compact-island-sculpt-v1");
    expect(sculpted.id).toBe("compact-duel-island-v2");
    expect(resolveWorldTerrainProfile(sculpted)).toEqual(sculpted);
    expect(
      deserializeWorldTerrainProfile(serializeWorldTerrainProfile(sculpted)),
    ).toEqual(sculpted);
    expect(worldTerrainProfileIdentity(sculpted)).not.toBe(
      worldTerrainProfileIdentity(blockout),
    );
    expect(() =>
      validateWorldTerrainProfile({ ...sculpted, algorithm: "unknown-sculpt" }),
    ).toThrow();
    expect(() =>
      validateWorldTerrainProfile({ ...sculpted, kind: "large-world" }),
    ).toThrow();
    expect(Object.isFrozen(sculpted.height)).toBe(true);
  });

  it("uses the same landform for main-thread height and island mask without biome-dependent cliffs", () => {
    const biomeWeightCases: Record<string, number>[] = [
      { forest: 1 },
      { canyon: 1 },
      { tundra: 1 },
      {},
    ];
    for (let x = 150; x <= 550; x += 8) {
      for (let z = 200; z <= 600; z += 8) {
        const y = height(x, z);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(sculpted.water.oceanFloorHeight);
        expect(y).toBeLessThan(45);
        for (const weights of biomeWeightCases) {
          expect(computeBaseHeight(x, z, noise, {}, weights, sculpted)).toBe(y);
        }
        expect(computeIslandMask(x, z, noise, sculpted)).toBe(
          landform.mask(x, z, noise, sculpted),
        );
      }
    }
  });

  it("keeps the working meadow near the authored grade with relief beside the campus", () => {
    for (const [x, z] of [
      [350, 320],
      [343, 302],
      [368, 419],
      [385, 374],
    ]) {
      expect(height(x, z)).toBeGreaterThan(26);
      expect(height(x, z)).toBeLessThan(31);
    }
    // Western landmark ridge is intentionally not centered under arena floors.
    expect(height(253, 403)).toBeGreaterThan(height(368, 419) + 8);
    for (let x = 320; x <= 410; x += 5) {
      for (let z = 350; z <= 485; z += 5) {
        expect(Math.abs(height(x, z) - 28.419301523097687)).toBeLessThan(5);
      }
    }
  });

  it("reaches a continuous seabed on all coastline bearings without a zero-height step", () => {
    for (let angle = 0; angle < 128; angle++) {
      const theta = (angle * Math.PI) / 64;
      const at = (r: number) =>
        [350 + Math.cos(theta) * r, 400 + Math.sin(theta) * r] as const;
      let inside = 100;
      let outside = 190;
      for (let i = 0; i < 48; i++) {
        const middle = (inside + outside) / 2;
        const [x, z] = at(middle);
        if (landform.mask(x, z, noise, sculpted) === 0) outside = middle;
        else inside = middle;
      }
      expect(height(...at(outside + 0.0001))).toBe(
        sculpted.water.oceanFloorHeight,
      );
      expect(
        Math.abs(
          height(...at(inside - 0.0001)) - sculpted.water.oceanFloorHeight,
        ),
      ).toBeLessThan(1e-7);
      expect(height(...at(inside - 1))).toBeGreaterThan(
        sculpted.water.oceanFloorHeight,
      );
    }
  });

  it("has no angular seam and translates the complete authoring shape with its profile", () => {
    const translated = validateWorldTerrainProfile({
      ...sculpted,
      id: "translated-sculpt-test",
      bounds: { minX: 1150, maxX: 1550, minZ: -800, maxZ: -400 },
      island: { ...sculpted.island, centerX: 1350, centerZ: -600 },
    });
    for (let r = 0; r <= 200; r += 2) {
      expect(height(350 - r, 400 - 1e-7)).toBeCloseTo(
        height(350 - r, 400 + 1e-7),
        5,
      );
      expect(
        landform.height(350 + r + 1000, 360 - 1000, noise, translated),
      ).toBeCloseTo(height(350 + r, 360), 10);
    }
  });

  it("is deterministic but responds to explicit seeded detail", () => {
    const otherNoise = new NoiseGenerator(41);
    const other = validateWorldTerrainProfile({ ...sculpted, seed: 41 });
    let differences = 0;
    for (let x = 250; x <= 450; x += 10) {
      const baseline = height(x, 330);
      expect(
        landform.height(x, 330, new NoiseGenerator(sculpted.seed), sculpted),
      ).toBe(baseline);
      if (
        Math.abs(landform.height(x, 330, otherNoise, other) - baseline) > 0.01
      )
        differences++;
    }
    expect(differences).toBeGreaterThan(10);
  });

  it("keeps embedded factory source self-contained after minification and keepNames", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../CompactIslandLandform.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "iife",
      globalName: "CompactLandformBundle",
      keepNames: true,
      minify: true,
    });
    const source = runInNewContext(
      `${result.outputFiles[0].text}\nCompactLandformBundle.buildCompactIslandLandformJS()`,
    ) as string;
    // Fresh realm: no bundler's function-name helper is made available.
    const embedded = runInNewContext(source) as ReturnType<
      typeof createCompactIslandLandform
    >;
    for (let x = 150; x <= 550; x += 11) {
      for (let z = 200; z <= 600; z += 11) {
        expect(embedded.height(x, z, noise, sculpted)).toBe(height(x, z));
        expect(embedded.mask(x, z, noise, sculpted)).toBe(
          landform.mask(x, z, noise, sculpted),
        );
      }
    }
  });
});

describe("bounded connected southern meadow candidate", () => {
  it("strictly admits immutable numerical data and binds every field to both host and emitted-worker identity", () => {
    expect(Object.isFrozen(meadowCandidate.southernMeadow)).toBe(true);
    expect(meadowCandidate.southernMeadow).not.toBe(meadowRecipe);
    expect(
      deserializeWorldTerrainProfile(
        serializeWorldTerrainProfile(meadowCandidate),
      ),
    ).toEqual(meadowCandidate);
    const reversed = {
      ...meadowCandidate,
      southernMeadow: Object.fromEntries(
        Object.entries(meadowRecipe).reverse(),
      ),
    };
    expect(
      serializeWorldTerrainProfile(validateWorldTerrainProfile(reversed)),
    ).toBe(serializeWorldTerrainProfile(meadowCandidate));
    expect(() =>
      assertEmittedInput(emittedRequest(meadowCandidate)),
    ).not.toThrow();
    for (const [key, value] of Object.entries(meadowRecipe)) {
      if (key === "schemaVersion") continue;
      const changed = validateWorldTerrainProfile({
        ...meadowBaseline,
        southernMeadow: { ...meadowRecipe, [key]: value + 0.001 },
      });
      expect(worldTerrainProfileIdentity(changed)).not.toBe(
        worldTerrainProfileIdentity(meadowCandidate),
      );
      expect(() => assertEmittedInput(emittedRequest(changed))).not.toThrow();
      const stale = emittedRequest(changed);
      stale.config = {
        ...stale.config,
        TERRAIN_PROFILE_IDENTITY: worldTerrainProfileIdentity(meadowCandidate),
      };
      expect(() => assertEmittedInput(stale)).toThrow();
    }
    for (const patch of [
      { schemaVersion: 2 },
      { minX: 500 },
      { maxZ: 350 },
      { featherX: 19.999 },
      { featherZ: 19.999 },
      { featherX: 70 },
      { minX: 270 },
      { maxX: 551 },
      { southHeight: 16 },
      { northHeight: 51 },
      { northHeight: 34 },
      { crossFall: 3.01 },
      { rollAmplitude: -0.1 },
      { rollAmplitude: 1.501 },
      { rollWavelength: 63.9 },
      { rollWavelength: 241 },
      { minZ: "345" },
      { extra: 1 },
    ]) {
      const raw = {
        ...meadowBaseline,
        southernMeadow: { ...meadowRecipe, ...patch },
      };
      expect(() => validateWorldTerrainProfile(raw)).toThrow();
      const input = emittedRequest(meadowCandidate);
      input.config = {
        ...input.config,
        TERRAIN_PROFILE: raw as WorldTerrainProfile,
        TERRAIN_PROFILE_IDENTITY:
          "hyperia-world-terrain-profile-v1\n" + JSON.stringify(raw),
      };
      expect(() => assertEmittedInput(input)).toThrow();
    }
    for (const value of [undefined, null, [], NaN, Infinity])
      expect(() =>
        validateWorldTerrainProfile({
          ...meadowBaseline,
          southernMeadow: value,
        }),
      ).toThrow();
    const getter = { ...meadowRecipe };
    let reads = 0;
    Object.defineProperty(getter, "northHeight", {
      enumerable: true,
      get() {
        reads++;
        return 26.8;
      },
    });
    expect(() => createCompactSouthernMeadow().validate(getter)).toThrow(
      /own data/,
    );
    expect(reads).toBe(0);
    expect(() =>
      createCompactSouthernMeadow().validate({
        ...meadowRecipe,
        [Symbol("hidden")]: 1,
      }),
    ).toThrow(/keys/);
    expect(() =>
      validateWorldTerrainProfile({
        ...sculpted,
        southernMeadow: meadowRecipe,
      }),
    ).toThrow();
  });

  it("preserves coast masks and exact original heights outside the finite support including the entire western ridge", () => {
    let changed = 0,
      preserved = 0;
    for (let x = 150; x <= 550; x += 2)
      for (let z = 200; z <= 600; z += 2) {
        const baseline = meadowHeight(x, z, meadowBaseline),
          candidate = meadowHeight(x, z);
        expect(Number.isFinite(candidate)).toBe(true);
        expect(candidate).toBeGreaterThanOrEqual(
          meadowCandidate.water.oceanFloorHeight,
        );
        expect(landform.mask(x, z, meadowNoise, meadowCandidate)).toBe(
          landform.mask(x, z, meadowNoise, meadowBaseline),
        );
        if (
          x <= meadowRecipe.minX ||
          x >= meadowRecipe.maxX ||
          z <= meadowRecipe.minZ ||
          z >= meadowRecipe.maxZ
        ) {
          expect(candidate).toBe(baseline);
          preserved++;
        } else if (Math.abs(candidate - baseline) > 1) changed++;
      }
    expect(preserved).toBeGreaterThan(30000);
    expect(changed).toBeGreaterThan(4000);
    // Existing bay remains open: the modifier cannot fill zero-mask seabed.
    expect(meadowHeight(415, 485)).toBe(meadowCandidate.water.oceanFloorHeight);
  });

  it("has finite continuous first derivatives at all four support edges and reaches the unchanged seabed continuously", () => {
    const e = 0.0001;
    for (let z = 345; z <= 535; z += 2)
      for (const x of [304, 500]) {
        const delta = (sx: number) =>
          meadowHeight(sx, z) - meadowHeight(sx, z, meadowBaseline);
        expect(delta(x)).toBe(0);
        expect(Math.abs(delta(x - e) / e)).toBeLessThan(0.00002);
        expect(Math.abs(delta(x + e) / e)).toBeLessThan(0.00002);
      }
    for (let x = 304; x <= 500; x += 2)
      for (const z of [345, 535]) {
        const delta = (sz: number) =>
          meadowHeight(x, sz) - meadowHeight(x, sz, meadowBaseline);
        expect(delta(z)).toBe(0);
        expect(Math.abs(delta(z - e) / e)).toBeLessThan(0.00002);
        expect(Math.abs(delta(z + e) / e)).toBeLessThan(0.00002);
      }
    for (let bearing = 0; bearing < 128; bearing++) {
      const theta = (bearing * Math.PI) / 64;
      const at = (r: number) =>
        [350 + Math.cos(theta) * r, 400 + Math.sin(theta) * r] as const;
      let inner = 100,
        outer = 190;
      for (let i = 0; i < 48; i++) {
        const middle = (inner + outer) / 2;
        if (landform.mask(...at(middle), meadowNoise, meadowCandidate) === 0)
          outer = middle;
        else inner = middle;
      }
      expect(meadowHeight(...at(outer + e))).toBe(
        meadowCandidate.water.oceanFloorHeight,
      );
      expect(
        Math.abs(
          meadowHeight(...at(inner - e)) -
            meadowCandidate.water.oceanFloorHeight,
        ),
      ).toBeLessThan(1e-7);
    }
  });

  it.each([meadowCandidate, world04Candidate])(
    "creates broad two-dimensional low meadow and a northern-neck connection without selecting a thin successful route",
    (profile) => {
      // Preselected rectangular areas, every half-metre sample. These measure
      // ungraded scalar terrain, not navigation/collider or retained-mesh approval.
      const bands = [
        {
          name: "meadow",
          minX: 328,
          maxX: 396,
          minZ: 390,
          maxZ: 455,
          minHeight: 24,
          maxHeight: 27,
          maxGrade: 0.06,
          samples: 17947,
        },
        {
          name: "northern-neck",
          minX: 400,
          maxX: 470,
          minZ: 425,
          maxZ: 452,
          minHeight: 23,
          maxHeight: 27,
          maxGrade: 0.4,
          samples: 7755,
        },
        {
          name: "coastal-descent",
          minX: 450,
          maxX: 466,
          minZ: 450,
          maxZ: 483,
          minHeight: 17.5,
          maxHeight: 25,
          maxGrade: 0.23,
          samples: 2211,
        },
      ];
      for (const band of bands) {
        let count = 0,
          low = Infinity,
          high = -Infinity;
        for (let x = band.minX; x <= band.maxX; x += 0.5)
          for (let z = band.minZ; z <= band.maxZ; z += 0.5) {
            const y = meadowHeight(x, z, profile);
            const grade = Math.hypot(
              (meadowHeight(x + 0.25, z, profile) -
                meadowHeight(x - 0.25, z, profile)) /
                0.5,
              (meadowHeight(x, z + 0.25, profile) -
                meadowHeight(x, z - 0.25, profile)) /
                0.5,
            );
            expect(y, band.name).toBeGreaterThan(band.minHeight);
            expect(y, band.name).toBeLessThan(band.maxHeight);
            expect(grade, band.name).toBeLessThan(band.maxGrade);
            low = Math.min(low, y);
            high = Math.max(high, y);
            count++;
          }
        expect(count).toBe(band.samples);
        expect(high - low).toBeGreaterThan(1);
      }
    },
  );

  it.each([meadowCandidate, headShoulderCandidate])(
    "emits identical admitted arithmetic after minification/keepNames without a module closure",
    async (candidate) => {
      const result = await build({
        entryPoints: [
          fileURLToPath(
            new URL("../CompactIslandLandform.ts", import.meta.url),
          ),
        ],
        bundle: true,
        write: false,
        platform: "neutral",
        format: "iife",
        globalName: "CompactLandformBundle",
        keepNames: true,
        minify: true,
      });
      const source = runInNewContext(
        `${result.outputFiles[0].text}\nCompactLandformBundle.buildCompactIslandLandformJS()`,
      ) as string;
      // Native workers receive realm-local structured clones. Keep the real
      // coastal apron's strict prototype admission; do not weaken it for a VM.
      const { embedded, profile } = runInNewContext(
        `${buildTerrainWorkerProfileGuardJS()}
       const input = JSON.parse(requestJSON);
       assertTerrainWorkerInput(input);
       ({ embedded: ${source}, profile: input.config.TERRAIN_PROFILE })`,
        { requestJSON: JSON.stringify(emittedRequest(candidate)) },
      ) as {
        embedded: ReturnType<typeof createCompactIslandLandform>;
        profile: WorldTerrainProfile;
      };
      for (let x = 295; x <= 510; x += 3)
        for (let z = 330; z <= 550; z += 3) {
          expect(embedded.height(x, z, meadowNoise, profile)).toBe(
            meadowHeight(x, z, candidate),
          );
          expect(embedded.mask(x, z, meadowNoise, profile)).toBe(
            landform.mask(x, z, meadowNoise, candidate),
          );
        }
    },
  );

  it.each([meadowCandidate, world04Candidate, headShoulderCandidate])(
    "runs actual emitted terrain-worker handlers for ridge, mainland and coast tiles with exact Float32 heights and normals",
    (profile) => {
      for (const [tileX, tileZ] of [
        [2, 4],
        [4, 4],
        [4, 5],
      ]) {
        const input = { ...emittedRequest(profile), tileX, tileZ };
        let response:
          { result?: TerrainWorkerOutput; error?: string } | undefined;
        runInNewContext(
          TERRAIN_WORKER_CODE +
            "\nself.onmessage({data:JSON.parse(requestJSON)});",
          {
            requestJSON: JSON.stringify(input),
            self: {
              postMessage(value: {
                result?: TerrainWorkerOutput;
                error?: string;
              }) {
                response = structuredClone(value);
              },
            },
          },
          { timeout: 5000 },
        );
        expect(response?.error).toBeUndefined();
        const output = response?.result;
        if (!output)
          throw new Error("Actual terrain worker produced no result");
        expect(output.terrainProfileIdentity).toBe(
          worldTerrainProfileIdentity(profile),
        );
        expect(output.heightData.length).toBe(51 * 51);
        for (let iz = 0; iz < 51; iz++)
          for (let ix = 0; ix < 51; ix++) {
            const x = tileX * 100 - 50 + ix * 2,
              z = tileZ * 100 - 50 + iz * 2,
              index = iz * 51 + ix;
            expect(output.heightData[index]).toBe(
              Math.fround(shoreHeight(x, z, profile)),
            );
            const dx =
              (Math.fround(shoreHeight(x + 2, z, profile)) -
                Math.fround(shoreHeight(x - 2, z, profile))) /
              4;
            const dz =
              (Math.fround(shoreHeight(x, z + 2, profile)) -
                Math.fround(shoreHeight(x, z - 2, profile))) /
              4;
            const length = Math.sqrt(dx * dx + 1 + dz * dz);
            expect(output.normalData[index * 3]).toBe(
              Math.fround(-dx / length),
            );
            expect(output.normalData[index * 3 + 1]).toBe(
              Math.fround(1 / length),
            );
            expect(output.normalData[index * 3 + 2]).toBe(
              Math.fround(-dz / length),
            );
          }
      }
    },
  );

  it("recomposes three equal cones into one long ridge shoulder and a lower southern outcrop, with a gradual cove head", () => {
    const crest = (z: number, profile: WorldTerrainProfile) => {
      let top = -Infinity;
      for (let x = 220; x <= 282; x += 0.5)
        top = Math.max(top, meadowHeight(x, z, profile));
      return top;
    };
    const dominant = [370, 375, 380, 385, 390, 395, 400, 405].map((z) =>
      crest(z, world04Candidate),
    );
    expect(Math.min(...dominant)).toBeGreaterThan(45);
    expect(Math.max(...dominant) - Math.min(...dominant)).toBeLessThan(2);
    expect(
      crest(385, world04Candidate) - crest(385, meadowCandidate),
    ).toBeGreaterThan(10);
    expect(crest(445, world04Candidate)).toBeLessThan(
      Math.max(...dominant) - 2,
    );
    expect(crest(430, world04Candidate)).toBeLessThan(
      crest(445, world04Candidate) - 5,
    );
    expect(meadowHeight(420, 460, world04Candidate)).toBeLessThan(24.2);
    expect(meadowHeight(420, 480, world04Candidate)).toBeGreaterThan(13);
    // The western promontory remains dry; the eastern admitted route is held.
    expect(meadowHeight(390, 480, world04Candidate)).toBeGreaterThan(25);
    expect(meadowHeight(450, 470, world04Candidate)).toBe(
      meadowHeight(450, 470, meadowCandidate),
    );
    expect(worldTerrainProfileIdentity(world04Candidate)).not.toBe(
      worldTerrainProfileIdentity(meadowCandidate),
    );
  });
});
