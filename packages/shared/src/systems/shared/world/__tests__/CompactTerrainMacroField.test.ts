import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  createCompactTerrainColorOperations,
  type CompactCoastDistributionMath,
  type CompactPondBankMath,
} from "../CompactTerrainPalette";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as profile,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import { createTerrainNoiseSampler } from "../TerrainNoiseSampler";
import type { FlatZone } from "../../../../types/world/terrain";

const ops = createCompactTerrainColorOperations();
const pondProfile = validateWorldTerrainProfile({
  ...profile,
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
const pond = Object.freeze({
  id: "haven-pond",
  centerX: 343,
  centerZ: 302,
  radius: 8,
  surfaceY: 27.8,
});
const numericMath: CompactCoastDistributionMath<number> = {
  constant(value) {
    return value;
  },
  add(a, b) {
    return a + b;
  },
  sub(a, b) {
    return a - b;
  },
  mul(a, b) {
    return a * b;
  },
  div(a, b) {
    return a / b;
  },
  min: Math.min,
  max: Math.max,
  clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  },
  smoothstep(low, high, value) {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  },
};

describe("admitted ridge colour field, independent of height and population", () => {
  it("uses the actual admitted curved spine, with a connected broad shoulder and asymmetric west rock", () => {
    const field = ops.macroField(profile)!;
    expect(Object.isFrozen(field)).toBe(true);
    expect(field).not.toBe(profile.landform);
    // Independent middle-of-ridge ground truth: p=.5, sin(pi/2)=1,
    // world spine X=350-82-30=238, Z=400+(-65+75)/2=405.
    expect(ops.macroWeights(238, 405, 0.5, field).dry).toBe(1);
    expect(ops.macroWeights(238 + 48 * 0.25, 405, 0.5, field).dry).toBe(1);
    expect(ops.macroWeights(238 + 48 * 1.85, 405, 0.5, field).dry).toBeCloseTo(
      0,
      13,
    );
    // Shoulder midpoint smoothstep is exactly .5, on both differently sized flanks.
    expect(ops.macroWeights(238 + 48 * 1.05, 405, 0.5, field).dry).toBeCloseTo(
      0.5,
      13,
    );
    expect(ops.macroWeights(238 - 26 * 1.05, 405, 0.5, field).dry).toBeCloseTo(
      0.5,
      13,
    );
    const west = ops.macroWeights(225, 410, 0.5, field);
    const east = ops.macroWeights(260, 410, 0.5, field);
    expect(west.westRock).toBeGreaterThan(0.5);
    expect(east.dry).toBeGreaterThan(0.9);
    expect(east.westRock).toBe(0);
    for (const point of [
      [350, 320],
      [343, 302],
      [280.5, 512.5],
      [288.5, 507.5],
    ])
      expect(ops.macroWeights(point[0], point[1], 0.5, field)).toEqual({
        dry: 0,
        westRock: 0,
      });
    expect(ops.macroWeights(335, 336, 0.5, field).dry).toBeGreaterThan(0);
    expect(ops.macroWeights(335, 336, 0.5, field).dry).toBeLessThan(0.001);
    // A tiny continuous taper can meet the southwest preparation edge. Do not
    // misrepresent a colour field as an exact campus exclusion/vegetation mask.
    const edge = ops.macroWeights(318.5, 344.5, 0.5, field);
    expect(edge.dry).toBeGreaterThan(0);
    expect(edge.dry).toBeLessThan(0.08);
  });

  it("is continuous across spine, ends and shoulder and stable under admitted coordinate translation/scale", () => {
    const field = ops.macroField(profile)!;
    const shifted = validateWorldTerrainProfile({
      ...profile,
      bounds: { minX: 1100, maxX: 1900, minZ: -800, maxZ: 0 },
      island: { ...profile.island, centerX: 1500, centerZ: -400, radius: 330 },
    });
    const shiftedField = ops.macroField(shifted)!;
    const epsilon = 1e-4;
    for (let x = 190; x <= 350; x += 5) {
      for (let z = 330; z <= 480; z += 5) {
        const actual = ops.macroWeights(x, z, 0.5, field);
        const moved = ops.macroWeights(
          1500 + (x - 350) * 2,
          -400 + (z - 400) * 2,
          0.5,
          shiftedField,
        );
        expect(moved.dry).toBeCloseTo(actual.dry, 12);
        expect(moved.westRock).toBeCloseTo(actual.westRock, 12);
        for (const delta of [
          [epsilon, 0],
          [0, epsilon],
        ]) {
          const near = ops.macroWeights(x + delta[0], z + delta[1], 0.5, field);
          expect(Math.abs(near.dry - actual.dry)).toBeLessThan(1e-5);
          expect(Math.abs(near.westRock - actual.westRock)).toBeLessThan(1e-5);
        }
        for (const weight of Object.values(actual)) {
          expect(weight).toBeGreaterThanOrEqual(0);
          expect(weight).toBeLessThanOrEqual(1);
        }
      }
    }
    // The true end fade has zero derivative at the admitted endpoints.
    for (const z of [335, 475]) {
      const center = ops.macroWeights(268, z, 0.5, field).dry;
      expect(center).toBe(0);
      for (const delta of [-epsilon, epsilon])
        expect(
          Math.abs(ops.macroWeights(268, z + delta, 0.5, field).dry - center) /
            epsilon,
        ).toBeLessThan(1e-5);
    }
  });

  it("retains legacy colour behavior and rejects malformed v3 field inputs without mutating the profile", () => {
    const before = JSON.stringify(profile);
    expect(ops.macroField(SCULPTED_COMPACT_V1_PROFILE_FIXTURE)).toBeNull();
    expect(ops.macroWeights(238, 405, 0.5, null)).toEqual({
      dry: 0,
      westRock: 0,
    });
    expect(() => ops.macroField({ ...profile, landform: undefined })).toThrow(
      /admitted ridge/,
    );
    for (const bad of [0, -1, Infinity, NaN]) {
      expect(() =>
        ops.macroField({
          ...profile,
          island: { ...profile.island, radius: bad },
        }),
      ).toThrow(/macro surface/);
      expect(() =>
        ops.macroField({
          ...profile,
          landform: { ...profile.landform!, ridgeWestWidth: bad },
        }),
      ).toThrow(/macro surface/);
    }
    expect(() =>
      ops.macroField({
        ...profile,
        landform: { ...profile.landform!, ridgeStartZ: 75 },
      }),
    ).toThrow(/macro surface/);
    expect(JSON.stringify(profile)).toBe(before);
    const old = ops.sample({
      noiseValue: 0.5,
      distortNoise: 0.5,
      slope: 0,
      roadInfluence: 0,
    });
    expect(
      ops.sample({
        noiseValue: 0.5,
        distortNoise: 0.5,
        slope: 0,
        roadInfluence: 0,
        surface: {
          x: 350,
          z: 320,
          height: 28.4,
          pond: null,
          macroField: ops.macroField(profile),
        },
      }),
    ).toEqual(old);
  });

  it("runs the freshly bundled minified keepNames factory in an isolated real Node worker", async () => {
    const bundled = await build({
      stdin: {
        contents: `import {createCompactTerrainColorOperations as factory} from ${JSON.stringify(new URL("../CompactTerrainPalette.ts", import.meta.url).pathname)}; export const source = factory.toString();`,
        resolveDir: process.cwd(),
        sourcefile: "macro-field-factory-entry.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      minify: true,
      keepNames: true,
    });
    const worker = new Worker(
      `
      const {parentPort} = require("node:worker_threads");
      const vm = require("node:vm");
      const module = {exports:{}};
      ${bundled.outputFiles[0].text}
      // Fresh realm has none of esbuild's outer helpers; mirrors the production
      // worker's factory.toString embedding, not a renderer or transport mock.
      const ops = vm.runInNewContext("(" + module.exports.source + ")()");
      parentPort.on("message", ({profile, points}) => {
        const field = ops.macroField(profile);
        parentPort.postMessage(points.map(([x,z,n]) => ({
          weights:ops.macroWeights(x,z,n,field),
          color:ops.sample({noiseValue:n,distortNoise:.5,slope:.08,roadInfluence:0,surface:{x,z,height:30,pond:null,macroField:field}})
        })));
      });
    `,
      { eval: true, env: {} },
    );
    try {
      const points: number[][] = [];
      for (const x of [225, 238, 260, 280, 350])
        for (const z of [335, 365, 405, 457, 475])
          for (const n of [0, 0.5, 1]) points.push([x, z, n]);
      const actual = await new Promise<unknown>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", resolve);
        worker.postMessage({ profile, points });
      });
      const field = ops.macroField(profile);
      expect(actual).toEqual(
        points.map(([x, z, n]) => ({
          weights: ops.macroWeights(x, z, n, field),
          color: ops.sample({
            noiseValue: n,
            distortNoise: 0.5,
            slope: 0.08,
            roadInfluence: 0,
            surface: { x, z, height: 30, pond: null, macroField: field },
          }),
        })),
      );
    } finally {
      await worker.terminate();
    }
  });
});

describe("explicit shared shore-contact-v1 pond distribution", () => {
  const field = ops.macroField(pondProfile, undefined, "shore-contact-v1")!;
  const descriptor = field.pondDistribution!;

  it("captures only the explicit mode and keeps historical modes and profile data exact", () => {
    const before = JSON.stringify(pondProfile);
    const historical = ops.macroField(pondProfile);
    for (const mode of [undefined, "relief-v1", "relief-contact-v1"] as const) {
      expect(ops.macroField(pondProfile, undefined, mode)).toEqual(historical);
      expect(ops.macroField(pondProfile, undefined, mode)).not.toHaveProperty(
        "pondDistribution",
      );
    }
    expect(Object.isFrozen(field)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(descriptor).toEqual({
      id: "shore-contact-v1",
      soilFullHeight: 0.055,
      soilEndHeight: 0.165,
    });
    const both = ops.macroField(
      pondProfile,
      "distribution-v1",
      "shore-contact-v1",
    )!;
    expect(both.pondDistribution).toBe(descriptor);
    expect(both.coastalDistribution).toEqual(
      ops.macroField(pondProfile, "distribution-v1")!.coastalDistribution,
    );
    for (const coast of ["detail-v1", "cavity-v1"] as const)
      expect(ops.macroField(pondProfile, coast, "shore-contact-v1")).toEqual(
        field,
      );
    expect(() =>
      ops.macroField(profile, undefined, "shore-contact-v1"),
    ).toThrow(/admitted coastal meadow/);
    expect(() =>
      ops.macroField(
        SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
        undefined,
        "shore-contact-v1",
      ),
    ).toThrow(/compact sculpt/);
    for (const invalid of [null, false, "shore-contact", {}, 0])
      expect(() => ops.pondBlend(invalid)).toThrow(/pond blend/);
    expect(JSON.stringify(pondProfile)).toBe(before);
  });

  it("admits only finite exact own-data descriptors into an immutable canonical value", () => {
    const copy = { ...descriptor };
    expect(ops.validatePondDistribution(copy)).toBe(descriptor);
    copy.soilFullHeight = 0.01;
    expect(descriptor.soilFullHeight).toBe(0.055);
    const nullPrototype = Object.assign(Object.create(null), descriptor);
    expect(ops.validatePondDistribution(nullPrototype)).toBe(descriptor);
    let reads = 0;
    const accessor = Object.defineProperty(
      { ...descriptor },
      "soilFullHeight",
      {
        enumerable: true,
        get() {
          reads++;
          return 0.055;
        },
      },
    );
    const hidden = Object.defineProperty({ ...descriptor }, "soilEndHeight", {
      value: 0.165,
      enumerable: false,
    });
    for (const invalid of [
      null,
      [],
      {},
      Object.create(descriptor),
      { ...descriptor, extra: true },
      { ...descriptor, [Symbol("extra")]: 1 },
      { ...descriptor, id: "relief-contact-v1" },
      { id: descriptor.id, soilFullHeight: 0.055 },
      ...[NaN, Infinity, -Infinity, 0.054, "0.055"].map((soilFullHeight) => ({
        ...descriptor,
        soilFullHeight,
      })),
      { ...descriptor, soilEndHeight: 0.166 },
      accessor,
      hidden,
    ])
      expect(() => ops.validatePondDistribution(invalid)).toThrow(
        /pond distribution/,
      );
    expect(reads).toBe(0);
  });

  it("centers the narrowed smooth transition and preserves exact wetness, radial domain and cliff soil", () => {
    const numeric = {
      constant(value: number) {
        return value;
      },
      add(a: number, b: number) {
        return a + b;
      },
      sub(a: number, b: number) {
        return a - b;
      },
      mul(a: number, b: number) {
        return a * b;
      },
      smoothstep(low: number, high: number, value: number) {
        const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
        return t * t * (3 - 2 * t);
      },
    };
    for (const noise of [0, 0.1, 0.5, 0.9, 1]) {
      const shift = (noise - 0.5) * 2 * 0.06;
      expect(
        ops.pondSoilCoverage(0.055 + shift, noise, descriptor, numeric),
      ).toBe(1);
      expect(
        ops.pondSoilCoverage(0.165 + shift, noise, descriptor, numeric),
      ).toBe(0);
      expect(
        ops.pondSoilCoverage(0.11 + shift, noise, descriptor, numeric),
      ).toBeCloseTo(0.5, 14);
      for (const radius of [0, 8, 10.25, 10.625, 11, 12]) {
        for (const height of [-0.2, 0, 0.055, 0.08, 0.11, 0.14, 0.165, 0.3]) {
          const input = {
            x: pond.centerX + radius,
            z: pond.centerZ,
            height: pond.surfaceY + height + shift,
            noiseValue: noise,
            pond,
          };
          const old = ops.pondWeights(input);
          const selected = ops.pondWeights(input, descriptor);
          const region = 1 - numeric.smoothstep(10.25, 11, radius);
          expect(selected.wetness).toBe(old.wetness);
          expect(selected.cliffSoil).toBe(old.soil);
          expect(selected.soil).toBe(
            region *
              ops.pondSoilCoverage(
                input.height - pond.surfaceY,
                noise,
                descriptor,
                numeric,
              ),
          );
          expect(selected.soil).toBeGreaterThanOrEqual(0);
          expect(selected.soil).toBeLessThanOrEqual(1);
          if (radius >= 11) expect(selected.soil).toBe(0);
          const oldWeights = ops.weights({
            noiseValue: 0.6,
            slope: 0.17,
            roadInfluence: 0,
            pondSurface: old,
          });
          const weights = ops.weights({
            noiseValue: 0.6,
            slope: 0.17,
            roadInfluence: 0,
            pondSurface: selected,
          });
          expect(weights.cliff).toBe(oldWeights.cliff);
          expect(weights.road).toBe(oldWeights.road);
        }
      }
    }
    const remote = { x: 0, z: 0, height: 0, noiseValue: 0.5, pond: null };
    expect(ops.pondWeights(remote, descriptor)).toEqual(
      ops.pondWeights(remote),
    );
  });

  it("uses selected soil for root color and final support without changing original acceptance or protected paths", () => {
    const oldField = ops.macroField(pondProfile)!;
    const palette = ops.getPalette();
    const c = ops.getComposition();
    for (const height of [0.075, 0.14]) {
      const input = {
        noiseValue: 0.5,
        distortNoise: 0.5,
        meadowNoise: 0,
        slope: 0,
        roadInfluence: 0,
        surface: {
          x: 350.2,
          z: 308,
          height: pond.surfaceY + height,
          pond,
          macroField: field,
        },
      };
      const old = {
        ...input,
        surface: { ...input.surface, macroField: oldField },
      };
      const kernelPond = ops.pondWeights(
        { ...input.surface, noiseValue: input.distortNoise },
        descriptor,
      );
      const margin = ops.pondMarginAt(input);
      const selectedPond = ops.pondWeights(
        { ...input.surface, noiseValue: input.distortNoise },
        descriptor,
        margin,
      );
      const weights = ops.weights({ ...input, pondSurface: selectedPond });
      expect(weights.cliff).toBe(0);
      expect(ops.grassSupportBeforeCoast(input)).toBe(
        ops.grassSupportBeforeCoast(old),
      );
      expect(ops.grassSupport(input)).toBe(
        (1 - weights.dirt) * (1 - weights.cliff),
      );
      // The prior centered kernel still has its original two-way effect. The
      // explicit habitat transfer is independently applied after that kernel.
      const kernelSupport =
        1 - ops.weights({ ...input, pondSurface: kernelPond }).dirt;
      if (height < 0.11)
        expect(kernelSupport).toBeLessThan(ops.grassSupport(old));
      else expect(kernelSupport).toBeGreaterThan(ops.grassSupport(old));
      // The generator, not this color sampler, must intersect with historical
      // accepted roots. A higher support value is never authority to add roots.
      const tint = ops.meadowTint(0, 0, c.coastalMeadowTintStrength);
      const wet = 1 + (c.pondWetAlbedo - 1) * selectedPond.wetness;
      const expected = palette.grass.map((grass, channel) => {
        const dry = grass * tint[channel] * margin.shade;
        return (
          (dry + (palette.dirt[channel] - dry) * weights.dirt) *
          weights.variation *
          wet
        );
      });
      expect(ops.sample(input)).toEqual({
        r: expected[0],
        g: expected[1],
        b: expected[2],
      });
      expect(ops.sample(input)).not.toEqual(ops.sample(old));
      expect(ops.sample({ ...input, roadInfluence: 1 })).toEqual(
        ops.sample({ ...old, roadInfluence: 1 }),
      );
      for (const surface of [
        { ...input.surface, pond: null },
        { ...input.surface, x: 370 },
        { ...input.surface, height: pond.surfaceY - 1 },
        { ...input.surface, height: pond.surfaceY + 1 },
      ]) {
        const current = { ...input, surface };
        const prior = {
          ...input,
          surface: { ...surface, macroField: oldField },
        };
        expect(ops.sample(current)).toEqual(ops.sample(prior));
        expect(ops.grassSupport(current)).toBe(ops.grassSupport(prior));
      }
    }
  });

  it("executes selected support and color with coast coexistence in an isolated minified keepNames worker", async () => {
    const bundled = await build({
      stdin: {
        contents: `import {createCompactTerrainColorOperations as factory} from ${JSON.stringify(new URL("../CompactTerrainPalette.ts", import.meta.url).pathname)}; export const source = factory.toString();`,
        resolveDir: process.cwd(),
        sourcefile: "pond-distribution-factory-entry.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      minify: true,
      keepNames: true,
    });
    const worker = new Worker(
      `
      const {parentPort} = require("node:worker_threads");
      const vm = require("node:vm");
      const module = {exports:{}};
      ${bundled.outputFiles[0].text}
      const ops = vm.runInNewContext("(" + module.exports.source + ")()");
      parentPort.on("message", ({profile, inputs}) => {
        const field = ops.macroField(profile, "distribution-v1", "shore-contact-v1");
        parentPort.postMessage(inputs.map(input => {
          input.surface.macroField = field;
          return {original:ops.grassSupportBeforeCoast(input),support:ops.grassSupport(input),color:ops.sample(input)};
        }));
      });
    `,
      { eval: true, env: {} },
    );
    try {
      const inputs = [-0.1, 0.05, 0.08, 0.11, 0.14, 0.2, 1].flatMap((height) =>
        [0, 0.5, 1].flatMap((noise) =>
          [pond, null].map((localPond) => ({
            noiseValue: noise,
            distortNoise: 1 - noise,
            slope: 0.08,
            roadInfluence: 0.25,
            surface: {
              x: 350.2,
              z: 308,
              height: pond.surfaceY + height,
              pond: localPond,
            },
          })),
        ),
      );
      const actual = await new Promise<unknown>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", resolve);
        worker.postMessage({ profile: pondProfile, inputs });
      });
      const both = ops.macroField(
        pondProfile,
        "distribution-v1",
        "shore-contact-v1",
      );
      expect(actual).toEqual(
        inputs.map((input) => {
          const selected = {
            ...input,
            surface: { ...input.surface, macroField: both },
          };
          return {
            original: ops.grassSupportBeforeCoast(selected),
            support: ops.grassSupport(selected),
            color: ops.sample(selected),
          };
        }),
      );
    } finally {
      await worker.terminate();
    }
  });

  it("bounds the immutable margin recipe and matches an independent full-domain numeric calculation", () => {
    const recipe = ops.getPondMarginRecipe();
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(recipe).toEqual({
      radiusFullOffset: 1,
      radiusEndOffset: 3,
      heightRiseStart: 0.035,
      heightRiseEnd: 0.105,
      heightFadeStart: 0.35,
      heightFadeEnd: 0.85,
      slopeFadeStart: 0.08,
      slopeFadeEnd: 0.22,
      roadEnd: 0.8,
      meadowFraction: 0.65,
      patchStart: 0.4,
      patchEnd: 0.55,
      coverStrength: 0.75,
      exposureStrength: 0.45,
      shadeStrength: 0.22,
      shadeBase: 0.3,
      clumpScaleStrength: 0.45,
      clumpScaleBase: 0.35,
    });
    const smooth = numericMath.smoothstep;
    for (const radius of [0, 8.5, 9.5, 10.5, 12])
      for (const height of [-1, 0, 0.035, 0.07, 0.105, 0.35, 0.6, 0.85, 1])
        for (const slope of [0, 0.15, 0.22])
          for (const [meadowNoise, distortNoise, roadInfluence] of [
            [0, 0, 0],
            [1, 1, 0],
            [0.45, 0.6, 0.4],
            [0.5, 0.5, 0.8],
          ]) {
            const input = {
              x: radius,
              z: 0,
              height,
              slope,
              meadowNoise,
              distortNoise,
              roadInfluence,
              pond: { centerX: 0, centerZ: 0, radius: 7.5, surfaceY: 0 },
              field,
            };
            const actual = ops.pondMargin(input, numericMath);
            const locality =
              (1 - smooth(8.5 ** 2, 10.5 ** 2, radius ** 2)) *
              smooth(0.035, 0.105, height) *
              (1 - smooth(0.35, 0.85, height)) *
              (1 - smooth(0.08, 0.22, slope)) *
              (1 - smooth(0, 0.8, roadInfluence));
            const patch = smooth(
              0.4,
              0.55,
              0.65 * meadowNoise + 0.35 * distortNoise,
            );
            const expected = {
              cover: 0.75 * locality * patch,
              exposure: 0.45 * locality * (1 - patch),
              shade: 1 - 0.22 * locality * (0.3 + 0.7 * (1 - patch)),
              clumpScale: 1 - 0.45 * locality * (0.35 + 0.65 * patch),
            };
            for (const key of [
              "cover",
              "exposure",
              "shade",
              "clumpScale",
            ] as const)
              expect(actual[key]).toBeCloseTo(expected[key], 14);
            expect(actual.cover).toBeGreaterThanOrEqual(0);
            expect(actual.cover).toBeLessThanOrEqual(0.75);
            expect(actual.exposure).toBeGreaterThanOrEqual(0);
            expect(actual.exposure).toBeLessThanOrEqual(0.45);
            expect(actual.shade).toBeGreaterThanOrEqual(0.78);
            expect(actual.shade).toBeLessThanOrEqual(1);
            expect(actual.clumpScale).toBeGreaterThanOrEqual(0.55);
            expect(actual.clumpScale).toBeLessThanOrEqual(1);
            if (locality === 0)
              expect(actual).toEqual({
                cover: 0,
                exposure: 0,
                shade: 1,
                clumpScale: 1,
              });
          }
  });

  it("keeps unselected, remote, submerged, road and steep domains exactly neutral", () => {
    const input = {
      noiseValue: 0.5,
      meadowNoise: 1,
      distortNoise: 1,
      slope: 0,
      roadInfluence: 0,
      surface: { x: 343, z: 302, height: 28, pond, macroField: field },
    };
    const neutral = { cover: 0, exposure: 0, shade: 1, clumpScale: 1 };
    for (const altered of [
      {
        ...input,
        surface: { ...input.surface, macroField: ops.macroField(pondProfile) },
      },
      { ...input, surface: { ...input.surface, macroField: null } },
      { ...input, surface: { ...input.surface, pond: null } },
      { ...input, surface: { ...input.surface, x: 354 } },
      { ...input, surface: { ...input.surface, height: 27.8 } },
      { ...input, surface: { ...input.surface, height: 29 } },
      { ...input, slope: 0.22 },
      { ...input, roadInfluence: 0.8 },
      { ...input, roadInfluence: 1 },
    ])
      expect(ops.pondMarginAt(altered)).toEqual(neutral);
    for (const soil of [0, 1e-12, 0.25, 0.9, 1])
      expect(ops.applyPondMarginSoil(soil, neutral, numericMath)).toBe(soil);
    const selected = ops.pondMarginAt(input);
    expect(selected).toEqual({
      cover: 0.75,
      exposure: 0,
      shade: 1 - 0.22 * 0.3,
      clumpScale: 0.55,
    });
    const translated = {
      ...input,
      surface: {
        ...input.surface,
        x: 443,
        z: 202,
        pond: { ...pond, centerX: 443, centerZ: 202 },
      },
    };
    expect(ops.pondMarginAt(translated)).toEqual(selected);
  });

  it("transfers soil both ways without changing legacy cliff/wetness and responds to actual nonradial noise", () => {
    const sampler = createTerrainNoiseSampler();
    const covers: number[] = [];
    for (let index = 0; index < 64; index++) {
      const angle = (index * Math.PI * 2) / 64;
      const x = pond.centerX + 8.5 * Math.cos(angle),
        z = pond.centerZ + 8.5 * Math.sin(angle);
      const input = {
        noiseValue: sampler.sample(x, z, 0.0008),
        meadowNoise: sampler.sample(
          x,
          z,
          ops.getComposition().meadowNoiseScale,
        ),
        distortNoise: sampler.sample(x, z, 0.067),
        slope: 0.02,
        roadInfluence: 0,
        surface: { x, z, height: pond.surfaceY + 0.2, pond, macroField: field },
      };
      const margin = ops.pondMarginAt(input);
      covers.push(margin.cover);
      const base = ops.pondWeights(
        { ...input.surface, noiseValue: input.distortNoise },
        descriptor,
      );
      const selected = ops.pondWeights(
        { ...input.surface, noiseValue: input.distortNoise },
        descriptor,
        margin,
      );
      expect(selected.cliffSoil).toBe(base.cliffSoil);
      expect(selected.wetness).toBe(base.wetness);
      expect(selected.soil).toBe(
        ops.applyPondMarginSoil(base.soil, margin, numericMath),
      );
      for (const soil of [0, 1e-12, 0.2, 0.5, 0.9, 1]) {
        const result = ops.applyPondMarginSoil(soil, margin, numericMath);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
    // Equal radius/height/slope still responds differently around the pond:
    // this is actual existing quantized noise, not an extra sampled field.
    expect(Math.max(...covers) - Math.min(...covers)).toBeGreaterThan(0.05);
    const groundcover = {
      cover: 0.75,
      exposure: 0,
      shade: 0.934,
      clumpScale: 0.55,
    };
    const sediment = {
      cover: 0,
      exposure: 0.45,
      shade: 0.78,
      clumpScale: 0.8425,
    };
    expect(ops.applyPondMarginSoil(1, groundcover, numericMath)).toBe(0.25);
    expect(ops.applyPondMarginSoil(0, sediment, numericMath)).toBe(0.45);
    const both = { cover: 0.4, exposure: 0.2, shade: 0.9, clumpScale: 0.8 };
    expect(ops.applyPondMarginSoil(0.5, both, numericMath)).toBe(
      0.3 + (1 - 0.3) * 0.2,
    );
  });
});

describe("composition-v1 geometry-owned bank families", () => {
  const water = { ...pond, radius: 7.5 };
  const bankMath: CompactPondBankMath<number> = {
    ...numericMath,
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    atan2: Math.atan2,
  };
  const neutral = {
    soilToGrass: 0,
    soilToRock: 0,
    grassToSoil: 0,
    grassToRock: 0,
    grassShade: 1,
    groundCoverWeight: 0,
    groundCoverGrassShare: 0,
  };
  function zone(): FlatZone {
    return {
      id: "haven_pond_floor",
      centerX: 343,
      centerZ: 302,
      width: 22,
      depth: 22,
      height: 26.6,
      blendRadius: 2,
      radialPond: {
        bedRadius: 5,
        bankInnerRadius: 6.5,
        bankOuterRadius: 9,
        bankHeight: 28.08,
        shorelineAmplitude: 0.9,
        bankSectors: [
          {
            bearing: -2.2,
            halfWidth: 0.7,
            innerRadius: 6.4,
            innerHeight: 28.08,
            outerRadius: 8.9,
            outerHeight: 28.3,
          },
          {
            bearing: -1.7,
            halfWidth: 0.6,
            innerRadius: 6.8,
            innerHeight: 27.9,
            outerRadius: 9.1,
            outerHeight: 28.2,
          },
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
          {
            bearing: 3.05,
            halfWidth: 0.6,
            innerRadius: 6.3,
            innerHeight: 28.08,
            outerRadius: 8.8,
            outerHeight: 28.4,
          },
        ],
        bankComposition: {
          schemaVersion: 1,
          sectors: [
            { sectorIndex: 0, surface: "sedge-shelf" },
            { sectorIndex: 1, surface: "cutbank" },
            { sectorIndex: 3, surface: "dry-turf" },
          ],
        },
      },
    };
  }
  function point(angle = -2.2, radius = 8, height = 28.04, slope = 0.04) {
    return {
      x: 343 + radius * Math.cos(angle),
      z: 302 + radius * Math.sin(angle),
      height,
      slope,
      distortNoise: 0.5,
      roadInfluence: 0,
    };
  }
  it("admits explicit mineral-shore without emergence and rejects forged source or detached groundCover", () => {
    const source = zone();
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [
        ...source.radialPond!.bankComposition!.sectors,
        { sectorIndex: 2, surface: "mineral-shore" },
      ],
    };
    const field = ops.pondBankField(source, water)!;
    expect(field.sectors[2].surface).toBe("mineral-shore");
    expect(field.sectors[2]).not.toHaveProperty("groundCover");
    expect(ops.validatePondBankField(structuredClone(field))).toEqual(field);
    expect(
      ops.bankComposition(
        { ...point(), field: ops.pondBankField(zone(), water) },
        bankMath,
      ),
    ).not.toHaveProperty("mineralSoilToRock");
    Object.assign(source.radialPond!.bankComposition!.sectors[3], {
      groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
    });
    expect(() => ops.pondBankField(source, water)).toThrow(
      /mineral-shore.*groundCover/,
    );
    const forged = structuredClone(field);
    Object.assign(forged.sectors[2], {
      groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
    });
    expect(() => ops.validatePondBankField(forged)).toThrow(
      /mineral-shore.*groundCover/,
    );
  });
  it("bounds mineral substrate by actual sector, shallow height, roads and shared noise without touching other transfers", () => {
    const source = zone();
    source.radialPond!.shorelineAmplitude = 0;
    source.radialPond!.bankSectors = [source.radialPond!.bankSectors![2]];
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [{ sectorIndex: 0, surface: "mineral-shore" }],
    };
    const field = ops.pondBankField(source, water)!;
    for (const radius of [0, 5, 5.5, 6.4, 7, 8, 9, 10.5, 11])
      for (const height of [27.6, 27.8, 27.9, 28, 28.1, 28.4])
        for (const distortNoise of [0, 0.35, 0.5, 0.65, 1]) {
          const p = { ...point(0.7, radius, height, 0), distortNoise, field };
          const actual = ops.bankComposition(p, bankMath);
          const expected =
            numericMath.smoothstep(5, 6.4, radius) *
            (1 - numericMath.smoothstep(6.4, 9, radius)) *
            (1 - numericMath.smoothstep(9.75, 10.5, radius)) *
            (1 - numericMath.smoothstep(0.1, 0.3, height - 27.8)) *
            (0.35 + 0.65 * numericMath.smoothstep(0.35, 0.65, distortNoise));
          expect(actual.mineralSoilToRock).toBeCloseTo(expected, 12);
          expect(actual.mineralSoilToRock).toBeGreaterThanOrEqual(0);
          expect(actual.mineralSoilToRock).toBeLessThanOrEqual(1);
          const { mineralSoilToRock: mineral, ...other } = actual;
          expect(other).toEqual(neutral);
          expect(mineral).toBeDefined();
          expect(
            ops.bankComposition({ ...p, roadInfluence: 0.8 }, bankMath)
              .mineralSoilToRock,
          ).toBe(0);
        }
    const duplicate = structuredClone(source);
    duplicate.radialPond!.bankSectors!.push({
      ...duplicate.radialPond!.bankSectors![0],
    });
    const p = { ...point(0.7, 7, 27.8, 0), field };
    expect(
      ops.bankComposition(
        { ...p, field: ops.pondBankField(duplicate, water) },
        bankMath,
      ).mineralSoilToRock,
    ).toBeCloseTo(ops.bankComposition(p, bankMath).mineralSoilToRock! / 2, 14);
  });
  it("keeps establishment and grass exact in overlapping mineral sectors while updating pure wet-soil mean colors", () => {
    const source = zone();
    const existing = source.radialPond!.bankSectors![0];
    source.radialPond!.bankSectors = [{ ...existing }, { ...existing }];
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [
        {
          sectorIndex: 0,
          surface: "sedge-shelf",
          groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
        },
        { sectorIndex: 1, surface: "mineral-shore" },
      ],
    };
    const selected = ops.pondBankField(source, water)!;
    const old = structuredClone(source);
    old.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: old.radialPond!.bankComposition!.sectors.slice(0, 1),
    };
    const control = ops.pondBankField(old, water)!;
    let changedColors = 0;
    for (const height of [27.8, 27.89, 27.95, 28, 28.04, 28.1, 28.4]) {
      const p = point(-2.2, 8, height, 0.04);
      const a = ops.bankComposition({ ...p, field: control }, bankMath);
      const b = ops.bankComposition({ ...p, field: selected }, bankMath);
      for (const weights of [
        [0, 1, 0, 0],
        [0.3, 0.4, 0.2, 0.1],
        [1, 0, 0, 0],
        [1e-20, 2e-20, 3e-20, 4e-20],
      ] as const) {
        const before = ops.bankCompositionWeights(weights, a, numericMath);
        const after = ops.bankCompositionWeights(weights, b, numericMath);
        expect(after[0]).toBe(before[0]);
        expect(after[3]).toBe(before[3]);
        expect(after[1]).toBeLessThanOrEqual(before[1]);
        expect(after[2]).toBeGreaterThanOrEqual(before[2]);
        expect(after.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
        expect(after.reduce((x, y) => x + y, 0)).toBeCloseTo(
          before.reduce((x, y) => x + y, 0),
          14,
        );
      }
      const base = {
        noiseValue: 0.5,
        meadowNoise: 0.5,
        distortNoise: 0.5,
        slope: p.slope,
        roadInfluence: 0,
        surface: {
          x: p.x,
          z: p.z,
          height,
          pond: water,
          macroField: ops.macroField(
            pondProfile,
            undefined,
            "composition-v1",
            control,
          ),
        },
      };
      const candidate = {
        ...base,
        surface: {
          ...base.surface,
          macroField: ops.macroField(
            pondProfile,
            undefined,
            "composition-v1",
            selected,
          ),
        },
      };
      expect(ops.grassSupport(candidate)).toBe(ops.grassSupport(base));
      expect(ops.grassSupportBeforeCoast(candidate)).toBe(
        ops.grassSupportBeforeCoast(base),
      );
      expect(
        ops.pondWeights({ ...candidate.surface, noiseValue: 0.5 }),
      ).toEqual(ops.pondWeights({ ...base.surface, noiseValue: 0.5 }));
      if (height === 27.8) {
        expect(ops.pondWeights({ ...base.surface, noiseValue: 0.5 }).soil).toBe(
          1,
        );
        expect(ops.sample(candidate)).not.toEqual(ops.sample(base));
      }
      if (
        JSON.stringify(ops.sample(candidate)) !==
        JSON.stringify(ops.sample(base))
      )
        changedColors++;
      expect(ops.sample({ ...candidate, roadInfluence: 1 })).toEqual(
        ops.sample({ ...base, roadInfluence: 1 }),
      );
    }
    expect(changedColors).toBeGreaterThan(0);
  });
  it("admits and freezes authored groundCover without inventing absent fields or accepting forged ranges", () => {
    const source = zone();
    Object.assign(source.radialPond!.bankComposition!.sectors[0], {
      groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
    });
    const field = ops.pondBankField(source, water)!;
    expect(field.sectors[0].groundCover).toEqual({
      emergenceHeight: 0.04,
      fullHeight: 0.12,
    });
    expect(Object.isFrozen(field.sectors[0].groundCover)).toBe(true);
    expect(field.sectors[1]).not.toHaveProperty("groundCover");
    expect(ops.validatePondBankField(structuredClone(field))).toEqual(field);
    for (const groundCover of [
      undefined,
      null,
      {},
      { emergenceHeight: 0, fullHeight: 0.12 },
      { emergenceHeight: 0.04, fullHeight: 0.04 },
      { emergenceHeight: 0.1, fullHeight: 0.10000000001 },
      { emergenceHeight: 0.04, fullHeight: 0.601 },
      { emergenceHeight: NaN, fullHeight: 0.12 },
      { emergenceHeight: 0.04, fullHeight: Infinity },
      { emergenceHeight: 0.04, fullHeight: 0.12, extra: 1 },
      Object.create({ emergenceHeight: 0.04, fullHeight: 0.12 }),
      Object.defineProperty({ fullHeight: 0.12 }, "emergenceHeight", {
        enumerable: true,
        get() {
          throw new Error("must not invoke");
        },
      }),
    ]) {
      const invalid = zone();
      Object.defineProperty(
        invalid.radialPond!.bankComposition!.sectors[0],
        "groundCover",
        { value: groundCover, enumerable: true },
      );
      expect(() => ops.pondBankField(invalid, water)).toThrow();
      const forged = structuredClone(field);
      Object.defineProperty(forged.sectors[0], "groundCover", {
        value: groundCover,
        enumerable: true,
      });
      expect(() => ops.validatePondBankField(forged)).toThrow();
    }
  });
  it("uses authored emergence as a conserved grass/soil target with broad bounded noise and exact protected domains", () => {
    const source = zone();
    source.radialPond!.shorelineAmplitude = 0;
    source.radialPond!.bankSectors = [source.radialPond!.bankSectors![0]];
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [
        {
          sectorIndex: 0,
          surface: "sedge-shelf",
          groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
        },
      ],
    };
    const field = ops.pondBankField(source, water)!;
    for (const noise of [0, 0.25, 0.5, 0.75, 1])
      for (const relativeHeight of [-0.2, 0, 0.03, 0.04, 0.08, 0.12, 0.13, 0.4])
        for (const slope of [0, 0.08, 0.16, 0.24, 0.6]) {
          const p = {
            ...point(-2.2, 8, 27.8 + relativeHeight, slope),
            distortNoise: noise,
            field,
          };
          const c = ops.bankComposition(p, bankMath);
          const shift = (noise - 0.5) * 0.02;
          const share =
            numericMath.smoothstep(
              0.04 + shift,
              0.12 + shift,
              p.height - 27.8,
            ) *
            (1 - numericMath.smoothstep(0.08, 0.24, slope));
          expect(c.groundCoverWeight).toBeCloseTo(1, 14);
          expect(c.groundCoverGrassShare).toBeCloseTo(share, 14);
          for (const weights of [
            [0.3, 0.4, 0.2, 0.1],
            [0, 1, 0, 0],
            [1, 0, 0, 0],
            [1e-20, 2e-20, 3e-20, 4e-20],
          ] as const) {
            const prior = ops.bankCompositionWeights(
              weights,
              { ...c, groundCoverWeight: 0, groundCoverGrassShare: 0 },
              numericMath,
            );
            const after = ops.bankCompositionWeights(weights, c, numericMath);
            expect(after[0]).toBeCloseTo((prior[0] + prior[1]) * share, 14);
            expect(after[2]).toBe(prior[2]);
            expect(after[3]).toBe(prior[3]);
            expect(after.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
            expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(
              weights.reduce<number>((a, b) => a + b, 0),
              14,
            );
          }
        }
    for (const p of [
      point(0.7),
      // Exact representable radial boundaries inside the sector: trig/world
      // subtraction can put a nominal radius 5 a few ULPs above the bed edge.
      { ...point(), x: 343, z: 291.5 }, // radius = 10.5 exactly
      { ...point(), x: 340, z: 298 }, // 3-4-5 radius = 5 exactly
      { ...point(), roadInfluence: 0.8 },
    ]) {
      const c = ops.bankComposition({ ...p, field }, bankMath);
      expect(c.groundCoverWeight).toBe(0);
      expect(c.groundCoverGrassShare).toBe(0);
    }
    source.radialPond!.bankSectors.push({
      ...source.radialPond!.bankSectors[0],
    });
    const overlap = ops.bankComposition(
      { ...point(), field: ops.pondBankField(source, water) },
      bankMath,
    );
    expect(overlap.groundCoverWeight).toBeCloseTo(0.5, 14);
    expect(overlap.groundCoverGrassShare).toBeCloseTo(0.5, 14);
  });
  it("releases only the authored fraction of historical placement caps without a jump at mixed-sector boundaries", () => {
    for (const selected of [0, 1e-20, 0.2, 0.8, 1])
      for (const historical of [0, 1e-20, 0.2, 0.8, 1])
        for (const weight of [0, 1e-12, 0.1, 0.5, 1]) {
          const result = ops.bankEstablishmentPlacement(
            selected,
            historical,
            weight,
          );
          const capped = Math.min(selected, historical);
          expect(result).toBeGreaterThanOrEqual(capped);
          expect(result).toBeLessThanOrEqual(selected);
          if (weight === 0) expect(result).toBe(capped);
          if (weight === 1) expect(result).toBe(selected);
          expect(result).toBeCloseTo(capped + (selected - capped) * weight, 14);
        }
    const source = zone();
    Object.assign(source.radialPond!.bankComposition!.sectors[0], {
      groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
    });
    const field = ops.pondBankField(source, water)!;
    const oldSector = field.sectors[1];
    expect(oldSector.surface).toBe("cutbank");
    expect(oldSector).not.toHaveProperty("groundCover");
    const boundary = field.sectors[0].bearing + field.sectors[0].halfWidth;
    const values = [-1e-5, -1e-7, 1e-7].map((offset) => {
      const c = ops.bankComposition(
        { ...point(boundary + offset), field },
        bankMath,
      );
      expect(c.grassToSoil + c.grassToRock).toBeGreaterThan(0);
      return ops.bankEstablishmentPlacement(0.8, 0.2, c.groundCoverWeight);
    });
    expect(values[0] - 0.2).toBeLessThan(1e-8);
    expect(values[1] - 0.2).toBeLessThan(1e-11);
    expect(values[2]).toBe(0.2);
  });
  it("updates actual CPU support and root-color decomposition while retaining legacy acceptance, pond wetness and unmapped behavior", () => {
    const source = zone(),
      baseline = ops.pondBankField(source, water)!;
    Object.assign(source.radialPond!.bankComposition!.sectors[0], {
      groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
    });
    const selected = ops.pondBankField(source, water)!;
    const p = point(-2.2, 8, 27.92, 0.03);
    const input = {
      noiseValue: 0.5,
      meadowNoise: 0.5,
      distortNoise: 0.5,
      slope: p.slope,
      roadInfluence: 0,
      surface: {
        x: p.x,
        z: p.z,
        height: p.height,
        pond: water,
        macroField: ops.macroField(
          pondProfile,
          undefined,
          "composition-v1",
          baseline,
        ),
      },
    };
    const candidate = {
      ...input,
      surface: {
        ...input.surface,
        macroField: ops.macroField(
          pondProfile,
          undefined,
          "composition-v1",
          selected,
        ),
      },
    };
    expect(ops.grassSupport(candidate)).toBeGreaterThan(
      ops.grassSupport(input),
    );
    expect(ops.grassSupportBeforeCoast(candidate)).toBe(
      ops.grassSupportBeforeCoast(input),
    );
    expect(ops.sample(candidate)).not.toEqual(ops.sample(input));
    expect(ops.pondWeights({ ...candidate.surface, noiseValue: 0.5 })).toEqual(
      ops.pondWeights({ ...input.surface, noiseValue: 0.5 }),
    );
    for (const pointOnSouth of [point(0.7), point(-2.2, 11)]) {
      const old = {
        ...input,
        surface: { ...input.surface, x: pointOnSouth.x, z: pointOnSouth.z },
      };
      const next = {
        ...candidate,
        surface: { ...candidate.surface, x: pointOnSouth.x, z: pointOnSouth.z },
      };
      expect(ops.sample(next)).toEqual(ops.sample(old));
      expect(ops.grassSupport(next)).toBe(ops.grassSupport(old));
    }
  });
  it("admits detached frozen geometry/water, preserves unmapped sectors and rejects forged fields", () => {
    const source = zone(),
      field = ops.pondBankField(source, water)!;
    expect(Object.isFrozen(field)).toBe(true);
    expect(Object.isFrozen(field.sectors)).toBe(true);
    expect(field.sectors.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(field.pond)).toBe(true);
    expect(field.sectors[2]).not.toHaveProperty("surface");
    expect(ops.validatePondBankField(structuredClone(field))).toEqual(field);
    source.radialPond!.bankSectors![0].innerRadius = 6.7;
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: source.radialPond!.bankComposition!.sectors.map((row, index) =>
        index === 0 ? { ...row, surface: "cutbank" } : row,
      ),
    };
    expect(field.sectors[0].innerRadius).toBe(6.4);
    expect(field.sectors[0].surface).toBe("sedge-shelf");
    expect(() => ops.pondBankField(null, water)).toThrow();
    expect(ops.pondBankField(source, null)).toBeNull();
    expect(() => ops.pondBankField(zone(), { ...water, centerX: 344 })).toThrow(
      /mismatch/,
    );
    const duplicate = zone();
    duplicate.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [
        ...duplicate.radialPond!.bankComposition!.sectors,
        { sectorIndex: 0, surface: "dry-turf" },
      ],
    };
    expect(() => ops.pondBankField(duplicate, water)).toThrow();
    const hole = zone();
    const holeRows = [...hole.radialPond!.bankComposition!.sectors];
    delete holeRows[0];
    hole.radialPond!.bankComposition = { schemaVersion: 1, sectors: holeRows };
    expect(() => ops.pondBankField(hole, water)).toThrow();
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...field }, "centerX", {
      enumerable: true,
      get() {
        getterCalls++;
        return 343;
      },
    });
    expect(() => ops.validatePondBankField(accessor)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() => ops.validatePondBankField({ ...field, extra: 0 })).toThrow();
    expect(() =>
      ops.validatePondBankField({
        ...field,
        pond: { ...water, surfaceY: Infinity },
      }),
    ).toThrow();
  });
  it("requires explicit composition binding while historical graphs and neutral remote kernels remain exact", () => {
    const field = ops.pondBankField(zone(), water)!;
    expect(() =>
      ops.macroField(pondProfile, undefined, "composition-v1"),
    ).toThrow(/explicit/);
    expect(
      ops.macroField(pondProfile, undefined, "composition-v1", field)
        ?.pondBankField,
    ).toEqual(field);
    expect(
      ops.macroField(pondProfile, undefined, "composition-v1", null)
        ?.pondBankField,
    ).toBeNull();
    expect(() =>
      ops.macroField(profile, undefined, "composition-v1", field),
    ).toThrow();
    for (const mode of [
      undefined,
      "relief-v1",
      "relief-contact-v1",
      "shore-contact-v1",
    ] as const)
      expect(ops.macroField(pondProfile, undefined, mode, field)).toEqual(
        ops.macroField(pondProfile, undefined, mode),
      );
    expect(ops.bankComposition({ ...point(), field: null }, bankMath)).toEqual(
      neutral,
    );
  });
  it("uses warped radius and normalized overlap including unmapped sectors rather than nearest-section painting", () => {
    const source = zone();
    source.radialPond!.bankSectors = [source.radialPond!.bankSectors![0]];
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [{ sectorIndex: 0, surface: "sedge-shelf" }],
    };
    const field = ops.pondBankField(source, water)!;
    const c = ops.getPondBankRecipe();
    for (const radius of [5.4, 6, 6.8, 8, 9, 9.8, 10.4])
      for (const angle of [-2.8, -2.4, -2.2, -1.8]) {
        const p = point(angle, radius);
        const actual = ops.bankComposition({ ...p, field }, bankMath);
        const raw = Math.hypot(p.x - 343, p.z - 302),
          theta = Math.atan2(p.z - 302, p.x - 343);
        const warped =
          raw -
          0.9 *
            (0.55 * Math.sin(2 * theta + 0.7) +
              0.3 * Math.sin(3 * theta - 0.4) +
              0.15 * Math.sin(5 * theta + 1.2)) *
            numericMath.smoothstep(0, 2.5, raw) *
            (1 - numericMath.smoothstep(6.5, 9, raw));
        const d = Math.abs(theta + 2.2),
          angular =
            1 - numericMath.smoothstep(0, 0.7, Math.min(d, 2 * Math.PI - d));
        const span =
          numericMath.smoothstep(5, 6.4, warped) *
          (1 - numericMath.smoothstep(8.9, 11, warped));
        const expected =
          angular *
          span *
          (1 - numericMath.smoothstep(9.75, 10.5, raw)) *
          c.sedgeCover *
          0.9;
        expect(actual.soilToGrass).toBeCloseTo(expected, 12);
      }
    const p = point();
    const single = ops.bankComposition({ ...p, field }, bankMath);
    source.radialPond!.bankSectors.push({
      ...source.radialPond!.bankSectors[0],
    });
    const overlap = ops.bankComposition(
      { ...p, field: ops.pondBankField(source, water) },
      bankMath,
    );
    expect(overlap.soilToGrass).toBeCloseTo(single.soilToGrass * 0.5, 14);
    expect(overlap.grassShade).toBeCloseTo(
      1 - (1 - single.grassShade) * 0.5,
      14,
    );
    const seamField = ops.pondBankField(zone(), water)!;
    const left = ops.bankComposition(
      { ...point(-Math.PI + 1e-8), field: seamField },
      bankMath,
    );
    const right = ops.bankComposition(
      { ...point(Math.PI - 1e-8), field: seamField },
      bankMath,
    );
    expect(left.soilToGrass).toBeCloseTo(right.soilToGrass, 6);
  });
  it("preserves wet vegetation bounds, neutral road/outer domains and conserved nonnegative material budgets", () => {
    const field = ops.pondBankField(zone(), water)!;
    for (const p of [
      { ...point(), x: 343, z: 302 },
      { ...point(), roadInfluence: 0.8 },
      point(-2.2, 10.5),
      point(-2.2, 11),
      point(0.7, 8),
    ])
      expect(ops.bankComposition({ ...p, field }, bankMath)).toEqual({
        ...neutral,
        substrateSoilToRock: 0,
      });
    const { substrateSoilToRock, ...wetVegetation } = ops.bankComposition(
      { ...point(), height: 27.8, field },
      bankMath,
    );
    expect(wetVegetation).toEqual(neutral);
    expect(substrateSoilToRock).toBeGreaterThan(0);
    for (const angle of [-2.2, -1.7, 3.05])
      for (const slope of [0, 0.04, 0.12, 0.25, 0.6]) {
        const composition = ops.bankComposition(
          { ...point(angle, 8, 28.04, slope), field },
          bankMath,
        );
        for (const weights of [
          [0.3, 0.4, 0.2, 0.1],
          [1e-20, 2e-20, 3e-20, 4e-20],
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 0.5, 0.5],
        ] as const) {
          const after = ops.bankCompositionWeights(
            weights,
            composition,
            numericMath,
          );
          expect(after.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
          expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(
            weights.reduce<number>((a, b) => a + b, 0),
            15,
          );
          expect(after[3]).toBe(weights[3]);
          expect(after[2]).toBeGreaterThanOrEqual(weights[2]);
        }
      }
  });
  it("shares CPU support/color without changing the historical same-geometry acceptance or wetness", () => {
    const bank = ops.pondBankField(zone(), water)!;
    const original = ops.macroField(pondProfile)!,
      selected = ops.macroField(
        pondProfile,
        undefined,
        "composition-v1",
        bank,
      )!;
    let colorChanged = 0,
      supportChanged = 0;
    for (const angle of [-2.2, -1.7, 0.7, 3.05])
      for (const height of [27.89, 27.94, 28.04, 28.1]) {
        const p = point(angle, 8, height);
        const base = {
          noiseValue: 0.5,
          meadowNoise: 0.5,
          distortNoise: p.distortNoise,
          slope: p.slope,
          roadInfluence: 0,
          surface: {
            x: p.x,
            z: p.z,
            height,
            pond: water,
            macroField: original,
          },
        };
        const candidate = {
          ...base,
          surface: { ...base.surface, macroField: selected },
        };
        expect(ops.grassSupportBeforeCoast(candidate)).toBe(
          ops.grassSupportBeforeCoast(base),
        );
        expect(
          ops.pondWeights({ ...candidate.surface, noiseValue: 0.5 }),
        ).toEqual(ops.pondWeights({ ...base.surface, noiseValue: 0.5 }));
        if (
          JSON.stringify(ops.sample(candidate)) !==
          JSON.stringify(ops.sample(base))
        )
          colorChanged++;
        if (ops.grassSupport(candidate) !== ops.grassSupport(base))
          supportChanged++;
        if (angle === 0.7) {
          expect(ops.sample(candidate)).toEqual(ops.sample(base));
          expect(ops.grassSupport(candidate)).toBe(ops.grassSupport(base));
        }
      }
    expect(colorChanged).toBeGreaterThan(0);
    expect(supportChanged).toBeGreaterThan(0);
  });
  it("continues only the normalized authored cut face through its wet toe using existing radial and slope bounds", () => {
    const source = zone();
    source.radialPond!.shorelineAmplitude = 0;
    source.radialPond!.bankSectors = [source.radialPond!.bankSectors![1]];
    source.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [{ sectorIndex: 0, surface: "cutbank" }],
    };
    const field = ops.pondBankField(source, water)!;
    for (const radius of [0, 5, 5.5, 6.8, 8, 9.1, 10, 10.5, 11])
      for (const slope of [0, 0.1, 0.15, 0.21, 0.32, 0.6])
        for (const height of [27.6, 27.8, 27.89, 28.1]) {
          const p = point(-1.7, radius, height, slope);
          const actual = ops.bankComposition({ ...p, field }, bankMath);
          const expected =
            numericMath.smoothstep(5, 6.8, radius) *
            (1 - numericMath.smoothstep(9.1, 11, radius)) *
            (1 - numericMath.smoothstep(9.75, 10.5, radius)) *
            0.82 *
            0.55 *
            numericMath.smoothstep(0.1, 0.32, slope);
          expect(actual.soilToRock).toBeCloseTo(expected, 12);
          expect(actual.soilToRock).toBeGreaterThanOrEqual(0);
          expect(actual.soilToRock).toBeLessThanOrEqual(0.451);
          if (height <= 27.89) {
            expect(actual.soilToGrass).toBe(0);
            expect(actual.grassToSoil).toBe(0);
            expect(actual.grassToRock).toBe(0);
            expect(actual.grassShade).toBe(1);
          }
          expect(
            ops.bankComposition({ ...p, field, roadInfluence: 0.8 }, bankMath),
          ).toEqual({ ...neutral, substrateSoilToRock: 0 });
        }
    const wet = point(-1.7, 8, 27.8, 0.32);
    const single = ops.bankComposition({ ...wet, field }, bankMath);
    expect(single.soilToRock).toBeCloseTo(0.451, 14);
    source.radialPond!.bankSectors.push({
      ...source.radialPond!.bankSectors[0],
    });
    const diluted = ops.bankComposition(
      { ...wet, field: ops.pondBankField(source, water) },
      bankMath,
    );
    expect(diluted.soilToRock).toBeCloseTo(single.soilToRock / 2, 14);
    for (const angle of [-2.31, -1.09, 0.7])
      expect(
        ops.bankComposition({ ...point(angle, 8, 27.8, 0.6), field }, bankMath),
      ).toEqual({ ...neutral, substrateSoilToRock: 0 });
  });
  it("moves only original soil remaining after cover, never newly exposed grass or coastal soil", () => {
    for (const soilToGrass of [0, 0.4, 1])
      for (const soilToRock of [0, 0.2, 0.451, 1])
        for (const weights of [
          [0.3, 0.4, 0.2, 0.1],
          [1e-20, 2e-20, 3e-20, 4e-20],
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 0.5, 0.5],
        ] as const) {
          const composition = {
            soilToGrass,
            soilToRock,
            grassToSoil: 0.7,
            grassToRock: 0.1,
            grassShade: 0.9,
            groundCoverWeight: 0,
            groundCoverGrassShare: 0,
          };
          const before = ops.bankCompositionWeights(
            weights,
            { ...composition, soilToRock: 0 },
            numericMath,
          );
          const after = ops.bankCompositionWeights(
            weights,
            composition,
            numericMath,
          );
          const transfer = (weights[1] - weights[1] * soilToGrass) * soilToRock;
          expect(after[0]).toBe(before[0]);
          expect(after[3]).toBe(before[3]);
          expect(after[1]).toBeCloseTo(before[1] - transfer, 15);
          expect(after[2]).toBeCloseTo(before[2] + transfer, 15);
          expect(after.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
          expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(
            weights.reduce<number>((a, b) => a + b, 0),
            15,
          );
          if (weights[1] === 0 || soilToGrass === 1)
            expect(after).toEqual(before);
        }
  });
  it("updates the pure wet-soil CPU color path while keeping grass support, acceptance and wetness exact", () => {
    const field = ops.pondBankField(zone(), water)!;
    const oldMacro = ops.macroField(pondProfile)!;
    const selected = ops.macroField(
      pondProfile,
      undefined,
      "composition-v1",
      field,
    )!;
    const p = point(-1.7, 8, 27.8, 0.32);
    const base = {
      noiseValue: 0.5,
      meadowNoise: 0.5,
      distortNoise: 0.5,
      slope: p.slope,
      roadInfluence: 0,
      surface: {
        x: p.x,
        z: p.z,
        height: p.height,
        pond: water,
        macroField: oldMacro,
      },
    };
    const candidate = {
      ...base,
      surface: { ...base.surface, macroField: selected },
    };
    const composition = ops.bankCompositionAt(candidate);
    expect(composition.soilToRock).toBeGreaterThan(0);
    expect(composition.soilToGrass).toBe(0);
    expect(composition.grassToRock).toBe(0);
    expect(composition.grassToSoil).toBe(0);
    expect(ops.pondWeights({ ...base.surface, noiseValue: 0.5 }).soil).toBe(1);
    expect(ops.pondWeights({ ...candidate.surface, noiseValue: 0.5 })).toEqual(
      ops.pondWeights({ ...base.surface, noiseValue: 0.5 }),
    );
    expect(ops.grassSupport(candidate)).toBe(ops.grassSupport(base));
    expect(ops.grassSupportBeforeCoast(candidate)).toBe(
      ops.grassSupportBeforeCoast(base),
    );
    expect(ops.sample(candidate)).not.toEqual(ops.sample(base));
    const road = { ...base, roadInfluence: 1 };
    expect(ops.sample({ ...candidate, roadInfluence: 1 })).toEqual(
      ops.sample(road),
    );
    const remote = {
      ...base,
      surface: {
        ...base.surface,
        macroField: ops.macroField(
          pondProfile,
          undefined,
          "composition-v1",
          null,
        ),
      },
    };
    expect(ops.sample(remote)).toEqual(ops.sample(base));
  });
  it("executes the detached factory in an isolated minified keepNames worker without captured helpers", async () => {
    const bundled = await build({
      stdin: {
        contents: `import {createCompactTerrainColorOperations as factory} from ${JSON.stringify(new URL("../CompactTerrainPalette.ts", import.meta.url).pathname)};export const source=factory.toString();`,
        resolveDir: process.cwd(),
        sourcefile: "pond-bank-factory.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      minify: true,
      keepNames: true,
    });
    const input = {
      zone: zone(),
      pond: water,
      profile: pondProfile,
      points: [
        point(-2.2),
        point(-1.7),
        point(0.7),
        point(3.05),
        point(-1.7, 8, 27.8, 0.32),
        point(0.7, 7, 27.8, 0),
      ],
    };
    input.zone.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [
        ...input.zone.radialPond!.bankComposition!.sectors,
        { sectorIndex: 2, surface: "mineral-shore" },
      ],
    };
    const worker = new Worker(
      `const {parentPort}=require("node:worker_threads");const vm=require("node:vm");const module={exports:{}};${bundled.outputFiles[0].text}
      parentPort.on("message",message=>{try{const result=vm.runInNewContext("(()=>{const ops=("+module.exports.source+")();const input=JSON.parse("+JSON.stringify(JSON.stringify(message))+");const bank=ops.pondBankField(input.zone,input.pond);const field=ops.macroField(input.profile,undefined,'composition-v1',bank);return input.points.map(p=>{const q={noiseValue:.5,meadowNoise:.5,distortNoise:p.distortNoise,slope:p.slope,roadInfluence:p.roadInfluence,surface:{x:p.x,z:p.z,height:p.height,pond:input.pond,macroField:field}};return {field:ops.validatePondBankField(bank),color:ops.sample(q),support:ops.grassSupport(q),original:ops.grassSupportBeforeCoast(q)};});})()");parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:String(error),stack:error.stack});}});`,
      { eval: true, env: {} },
    );
    try {
      const received = await new Promise<{ result?: unknown; error?: string }>(
        (resolve, reject) => {
          worker.once("error", reject);
          worker.once("message", resolve);
          worker.postMessage(input);
        },
      );
      expect(received.error).toBeUndefined();
      const field = ops.pondBankField(input.zone, water)!;
      const macro = ops.macroField(
        pondProfile,
        undefined,
        "composition-v1",
        field,
      );
      expect(received.result).toEqual(
        input.points.map((p) => {
          const q = {
            noiseValue: 0.5,
            meadowNoise: 0.5,
            distortNoise: p.distortNoise,
            slope: p.slope,
            roadInfluence: p.roadInfluence,
            surface: {
              x: p.x,
              z: p.z,
              height: p.height,
              pond: water,
              macroField: macro,
            },
          };
          return {
            field,
            color: ops.sample(q),
            support: ops.grassSupport(q),
            original: ops.grassSupportBeforeCoast(q),
          };
        }),
      );
    } finally {
      await worker.terminate();
    }
  });
});
