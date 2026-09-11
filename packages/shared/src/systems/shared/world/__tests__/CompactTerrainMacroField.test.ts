import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as profile,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";

const ops = createCompactTerrainColorOperations();

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
