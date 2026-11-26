import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import shoulderData from "../../../../data/compact-haven-shoulder-v1.json";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import {
  createCompactHavenShoulder,
  type CompactHavenShoulder,
} from "../CompactHavenShoulder";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import {
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE as candidate,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as baseline,
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE as earlier,
  serializeWorldTerrainProfile,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

type Recipe = typeof shoulderData;
type Factory = ReturnType<typeof createCompactHavenShoulder>;
const recipe = (): Recipe => structuredClone(shoulderData);
const originalRecipe = (): Recipe => ({
  ...recipe(),
  faceChamfer: 0.2,
  faceRun: 6,
  notchDepth: 2.1,
  notchWidth: 3.2,
  notchEndFade: 5,
});

// Independent pre-integration scalar reference from external authoring prototype
// 82c372987c1d0a6e1423d44d37c56b1c12542e30c5af7c16dedffdc9d91c43f4.
// This literal retains the original per-sample tangents and notch arithmetic;
// it does not use production curve compilation or sample helpers.
const prototype = {
  minX: 272,
  maxX: 314,
  minZ: 303,
  maxZ: 367,
  grade: 28.419301523097687,
  crest: [
    [286, 310, 31.3],
    [290, 319, 36.7],
    [287, 328, 39],
    [289, 337, 36.5],
    [282, 349, 37.2],
    [278, 359, 35.6],
  ],
  shelf: [
    [296, 310, 30],
    [300, 319, 33.2],
    [298, 328, 34.9],
    [303, 337, 32.7],
    [297, 349, 32.8],
    [294, 359, 31.6],
  ],
  toe: [
    [308, 310, 28.6],
    [311, 319, 28.8],
    [311, 328, 29],
    [312, 337, 28.85],
    [310, 349, 28.7],
    [307, 359, 28.8],
  ],
  notch: [
    [283, 331],
    [290, 334],
    [299, 338],
    [307, 340],
  ],
};
function prototypeHeight(
  x: number,
  z: number,
  previousHeight: number,
  notchPoints: number[][] = prototype.notch,
): number {
  const p = prototype;
  const smooth = (v: number) => {
    const t = Math.max(0, Math.min(1, v));
    return t * t * (3 - 2 * t);
  };
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  function curve(points: number[][], field: 0 | 2): number {
    const last = points.length - 1;
    if (z <= points[0][1]) return points[0][field];
    if (z >= points[last][1]) return points[last][field];
    let i = 0;
    while (z > points[i + 1][1]) i++;
    const secant = (j: number) =>
      (points[j + 1][field] - points[j][field]) /
      (points[j + 1][1] - points[j][1]);
    const tangent = (j: number) => {
      if (j === 0 || j === last) return 0;
      const a = secant(j - 1),
        b = secant(j);
      if (a * b <= 0) return 0;
      const h0 = points[j][1] - points[j - 1][1],
        h1 = points[j + 1][1] - points[j][1];
      const w0 = 2 * h1 + h0,
        w1 = h1 + 2 * h0;
      return (w0 + w1) / (w0 / a + w1 / b);
    };
    const h = points[i + 1][1] - points[i][1],
      t = (z - points[i][1]) / h;
    return (
      (2 * t * t * t - 3 * t * t + 1) * points[i][field] +
      (t * t * t - 2 * t * t + t) * h * tangent(i) +
      (-2 * t * t * t + 3 * t * t) * points[i + 1][field] +
      (t * t * t - t * t) * h * tangent(i + 1)
    );
  }
  const plane = (value: number) => {
    const t = Math.max(0, Math.min(1, value)),
      r = 0.2;
    if (t < r) return (t * t) / (2 * r * (1 - r));
    if (t > 1 - r) return 1 - ((1 - t) * (1 - t)) / (2 * r * (1 - r));
    return (t - r / 2) / (1 - r);
  };
  if (x <= p.minX || x >= p.maxX || z <= p.minZ || z >= p.maxZ)
    return previousHeight;
  const weight =
    smooth((x - p.minX) / 6) *
    smooth((p.maxX - x) / 3) *
    smooth((z - p.minZ) / 7) *
    smooth((p.maxZ - z) / 8);
  const cx = curve(p.crest, 0),
    cy = curve(p.crest, 2),
    sx = curve(p.shelf, 0),
    sy = curve(p.shelf, 2),
    tx = curve(p.toe, 0),
    ty = curve(p.toe, 2);
  const faceEnd = cx + Math.min(6, sx - cx - 1.5);
  let target: number;
  if (x < cx - 2)
    target = mix(previousHeight, cy, plane((x - p.minX) / (cx - 2 - p.minX)));
  else if (x < cx) target = cy;
  else if (x < faceEnd) target = mix(cy, sy, plane((x - cx) / (faceEnd - cx)));
  else if (x < sx) target = sy;
  else if (x < tx) target = mix(sy, ty, plane((x - sx) / (tx - sx)));
  else target = mix(ty, previousHeight, smooth((x - tx) / (p.maxX - tx)));
  let length = 0,
    bestDistance = Infinity,
    bestAlong = 0;
  for (let i = 1; i < notchPoints.length; i++) {
    const a = notchPoints[i - 1],
      b = notchPoints[i],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      segmentLength = Math.hypot(dx, dz);
    const t = Math.max(
      0,
      Math.min(
        1,
        ((x - a[0]) * dx + (z - a[1]) * dz) / (segmentLength * segmentLength),
      ),
    );
    const distance = Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAlong = length + t * segmentLength;
    }
    length += segmentLength;
  }
  const cut =
    2.1 *
    smooth(1 - bestDistance / 3.2) *
    smooth(bestAlong / 5) *
    smooth((length - bestAlong) / 5);
  return mix(previousHeight, Math.max(p.grade, target - cut), weight);
}

function freshFactory(
  source: string,
  input: Recipe = recipe(),
): {
  factory: Factory;
  descriptor: CompactHavenShoulder;
} {
  // JSON parsing inside the new realm models the worker's structured-clone
  // boundary; host objects injected directly into a VM are not worker inputs.
  return runInNewContext(
    `
    const factory = (${source})();
    const descriptor = factory.validate(JSON.parse(recipeJSON));
    ({factory, descriptor});
  `,
    { recipeJSON: JSON.stringify(input) },
  );
}

describe("explicit bounded Haven shoulder", () => {
  it("retains prototype control-point geometry with explicit revised candidate parameters", () => {
    const {
      schemaVersion,
      westFade,
      eastFade,
      northFade,
      southFade,
      crestWidth,
      faceRun,
      shelfMinWidth,
      faceChamfer,
      notchDepth,
      notchWidth,
      notchEndFade,
      ...shape
    } = shoulderData;
    expect(shape).toEqual(prototype);
    expect({
      schemaVersion,
      westFade,
      eastFade,
      northFade,
      southFade,
      crestWidth,
      faceRun,
      shelfMinWidth,
      faceChamfer,
      notchDepth,
      notchWidth,
      notchEndFade,
    }).toEqual({
      schemaVersion: 1,
      westFade: 6,
      eastFade: 3,
      northFade: 7,
      southFade: 8,
      crestWidth: 2,
      faceRun: 8,
      shelfMinWidth: 1.5,
      faceChamfer: 0.25,
      notchDepth: 1.2,
      notchWidth: 6,
      notchEndFade: 6,
    });
  });

  it("detaches, canonicalizes and deeply freezes all admitted values", () => {
    const factory = createCompactHavenShoulder(),
      input = recipe();
    input.notchDepth = -0;
    const descriptor = factory.validate(input);
    expect(descriptor).not.toBe(input);
    expect(Object.is(descriptor.notchDepth, -0)).toBe(false);
    expect(Object.isFrozen(descriptor)).toBe(true);
    for (const key of ["crest", "shelf", "toe", "notch"] as const) {
      expect(descriptor[key]).not.toBe(input[key]);
      expect(Object.isFrozen(descriptor[key])).toBe(true);
      descriptor[key].forEach((point, i) => {
        expect(point).not.toBe(input[key][i]);
        expect(Object.isFrozen(point)).toBe(true);
      });
    }
    const before = factory.sample(287, 328, 28, descriptor);
    input.crest[2][2] = 45;
    expect(factory.sample(287, 328, 28, descriptor)).toBe(before);
    expect(Reflect.set(descriptor.crest[2], "2", 45)).toBe(false);
    const reordered = Object.fromEntries(Object.entries(recipe()).reverse());
    expect(JSON.stringify(factory.validate(reordered))).toBe(
      JSON.stringify(factory.validate(recipe())),
    );
    expect(
      factory.validate(Object.assign(Object.create(null), recipe())),
    ).toEqual(shoulderData);
  });

  it("rejects non-data records and arrays without invoking getters or inherited methods", () => {
    const factory = createCompactHavenShoulder();
    let accesses = 0;
    const ownGetter = recipe();
    Object.defineProperty(ownGetter, "grade", {
      get() {
        accesses++;
        return 28;
      },
    });
    const tupleGetter = recipe();
    Object.defineProperty(tupleGetter.crest[0], "0", {
      get() {
        accesses++;
        return 286;
      },
    });
    const customArray = recipe();
    const inherited = Object.create(Array.prototype);
    Object.defineProperty(inherited, "map", {
      get() {
        accesses++;
        throw Error("Inherited array method executed");
      },
    });
    Object.setPrototypeOf(customArray.crest, inherited);
    const customTuple = recipe();
    Object.setPrototypeOf(customTuple.crest[0], Object.create(Array.prototype));
    const symbol = recipe();
    Object.defineProperty(symbol, Symbol("extra"), { value: 1 });
    const sparse = recipe();
    Reflect.deleteProperty(sparse.crest[0], "1");
    const hidden = recipe();
    Object.defineProperty(hidden.notch, "hidden", { value: 1 });
    const customRecord = Object.assign(
      Object.create({ inherited: true }),
      recipe(),
    );
    for (const input of [
      undefined,
      null,
      [],
      1,
      "shape",
      ownGetter,
      tupleGetter,
      customArray,
      customTuple,
      symbol,
      sparse,
      hidden,
      customRecord,
    ])
      expect(() => factory.validate(input)).toThrow(
        /Invalid compact Haven shoulder/,
      );
    expect(accesses).toBe(0);
  });

  it("does not treat a frozen accessor or an outside query as descriptor admission", () => {
    const factory = createCompactHavenShoulder();
    let accesses = 0;
    const accessor = recipe();
    Object.defineProperty(accessor, "minX", {
      get() {
        accesses++;
        return 272;
      },
    });
    Object.freeze(accessor);
    for (const [x, z] of [
      [287, 328],
      [0, 0],
    ]) {
      expect(() =>
        factory.sample(x, z, 28, accessor as CompactHavenShoulder),
      ).toThrow(/accessors/);
      expect(() =>
        factory.sample(x, z, 28, recipe() as CompactHavenShoulder),
      ).toThrow(/unadmitted mutable/);
    }
    expect(accesses).toBe(0);
  });

  const corruptions: Array<[string, (value: Recipe) => void]> = [
    [
      "schema",
      (p) => {
        p.schemaVersion = 2;
      },
    ],
    [
      "missing field",
      (p) => {
        Reflect.deleteProperty(p, "grade");
      },
    ],
    [
      "extra field",
      (p) => {
        Object.assign(p, { extra: 1 });
      },
    ],
    [
      "non-finite",
      (p) => {
        p.grade = NaN;
      },
    ],
    [
      "infinity",
      (p) => {
        p.faceRun = Infinity;
      },
    ],
    [
      "coercion",
      (p) => {
        Object.assign(p, { faceRun: "6" });
      },
    ],
    [
      "bounds",
      (p) => {
        p.maxX = p.minX;
      },
    ],
    [
      "unbounded extent",
      (p) => {
        p.maxZ = p.minZ + 129;
      },
    ],
    [
      "unbounded coordinate",
      (p) => {
        p.minX = -10001;
      },
    ],
    [
      "fade",
      (p) => {
        p.eastFade = 0;
      },
    ],
    [
      "overlapping fades",
      (p) => {
        p.westFade = 42;
      },
    ],
    [
      "chamfer",
      (p) => {
        p.faceChamfer = 0.5;
      },
    ],
    [
      "negative notch",
      (p) => {
        p.notchDepth = -1;
      },
    ],
    [
      "unbounded notch",
      (p) => {
        p.notchWidth = 9;
      },
    ],
    [
      "empty curve",
      (p) => {
        p.crest = [];
      },
    ],
    [
      "unbounded curve",
      (p) => {
        p.crest = Array.from({ length: 17 }, () => [286, 310, 31]);
      },
    ],
    [
      "tuple arity",
      (p) => {
        p.crest[0].push(1);
      },
    ],
    [
      "non-finite tuple",
      (p) => {
        p.toe[0][2] = Infinity;
      },
    ],
    [
      "unequal counts",
      (p) => {
        p.shelf.pop();
      },
    ],
    [
      "different z knots",
      (p) => {
        p.shelf[1][1] += 0.1;
      },
    ],
    [
      "duplicate z",
      (p) => {
        for (const curve of [p.crest, p.shelf, p.toe])
          curve[1][1] = curve[0][1];
      },
    ],
    [
      "short z interval",
      (p) => {
        for (const curve of [p.crest, p.shelf, p.toe])
          curve[1][1] = curve[0][1] + 1;
      },
    ],
    [
      "below grade",
      (p) => {
        p.toe[0][2] = p.grade - 1;
      },
    ],
    [
      "height cap",
      (p) => {
        p.crest[0][2] = p.grade + 25;
      },
    ],
    [
      "west branch width",
      (p) => {
        p.crest[5][0] = p.minX + 3;
      },
    ],
    [
      "overlapping global hulls",
      (p) => {
        p.shelf[0][0] = 291;
      },
    ],
    [
      "toe branch width",
      (p) => {
        p.toe[0][0] = 303;
      },
    ],
    [
      "east branch width",
      (p) => {
        p.toe[0][0] = p.maxX - 0.5;
      },
    ],
    [
      "notch bounds",
      (p) => {
        p.notch[0][0] = p.minX;
      },
    ],
    [
      "notch zero segment",
      (p) => {
        p.notch[1] = [...p.notch[0]];
      },
    ],
    [
      "notch end fades",
      (p) => {
        p.notchEndFade = 16;
      },
    ],
  ];
  it.each(corruptions)(
    "rejects %s corruption before compilation",
    (_name, corrupt) => {
      const input = recipe();
      corrupt(input);
      expect(() => createCompactHavenShoulder().validate(input)).toThrow(
        /Invalid compact Haven shoulder/,
      );
    },
  );

  it("binds every new field to content identity without changing the baseline fixture", () => {
    expect(baseline.havenShoulder).toBeUndefined();
    expect(candidate.id).toBe(baseline.id);
    expect(candidate.algorithm).toBe(baseline.algorithm);
    expect(worldTerrainProfileIdentity(candidate)).not.toBe(
      worldTerrainProfileIdentity(baseline),
    );
    const { havenShoulder, ...without } = candidate;
    expect(without).toEqual(baseline);
    expect(havenShoulder).toEqual(shoulderData);
    for (const key of Object.keys(shoulderData) as Array<keyof Recipe>) {
      if (key === "schemaVersion") continue;
      const changed = recipe();
      if (Array.isArray(changed[key])) changed[key][0][0] += 0.01;
      else Object.assign(changed, { [key]: Number(changed[key]) + 0.001 });
      const profile = validateWorldTerrainProfile({
        ...baseline,
        havenShoulder: changed,
      });
      expect(worldTerrainProfileIdentity(profile)).not.toBe(
        worldTerrainProfileIdentity(candidate),
      );
    }
    for (const value of [undefined, null, {}])
      expect(() =>
        validateWorldTerrainProfile({ ...baseline, havenShoulder: value }),
      ).toThrow();
    expect(() =>
      validateWorldTerrainProfile({ ...earlier, havenShoulder: shoulderData }),
    ).toThrow();
    const reordered = Object.fromEntries(Object.entries(candidate).reverse());
    expect(
      serializeWorldTerrainProfile(validateWorldTerrainProfile(reordered)),
    ).toBe(serializeWorldTerrainProfile(candidate));
  });

  it("keeps compiled descriptors and same-ID profiles isolated across repeated calls", () => {
    const factory = createCompactHavenShoulder(),
      secondFactory = createCompactHavenShoulder();
    // Remove only drainage for this isolated cache oracle: the actual wider
    // candidate notch now reaches the peak and legitimately lowers it.
    const a = factory.validate({ ...recipe(), notchDepth: 0 }),
      changed = { ...recipe(), notchDepth: 0 };
    changed.crest[2][2] = 40;
    const b = factory.validate(changed),
      profileA = validateWorldTerrainProfile({
        ...candidate,
        havenShoulder: a,
      }),
      profileB = validateWorldTerrainProfile({
        ...candidate,
        havenShoulder: b,
      });
    const landform = createCompactIslandLandform(createCompactHavenShoulder),
      noise = new NoiseGenerator(0);
    expect(profileB.id).toBe(candidate.id);
    for (let i = 0; i < 50; i++) {
      expect(factory.sample(287, 328, 28, a)).toBe(39);
      expect(factory.sample(287, 328, 28, b)).toBe(40);
      expect(secondFactory.sample(287, 328, 28, a)).toBe(39);
      expect(secondFactory.sample(287, 328, 28, b)).toBe(40);
      expect(landform.height(287, 328, noise, profileA)).toBe(39);
      expect(landform.height(287, 328, noise, profileB)).toBe(40);
    }
    expect(() =>
      secondFactory.sample(287, 328, 28, recipe() as CompactHavenShoulder),
    ).toThrow(/unadmitted mutable/);
    for (const values of [
      [NaN, 328, 28],
      [287, Infinity, 28],
      [287, 328, NaN],
    ])
      expect(() => factory.sample(values[0], values[1], values[2], a)).toThrow(
        /sample input/,
      );
  });

  it("joins the outside surface exactly with shrinking outer-collar delta derivatives", () => {
    const factory = createCompactHavenShoulder(),
      p = factory.validate(recipe());
    const old = (x: number, z: number) => 28 + 0.01 * x - 0.005 * z;
    const boundary = (epsilon: number) => {
      let maximum = 0;
      for (let z = p.minZ; z <= p.maxZ; z += 0.5) {
        for (const x of [p.minX, p.maxX])
          expect(factory.sample(x, z, old(x, z), p)).toBe(old(x, z));
        for (const x of [p.minX + epsilon, p.maxX - epsilon])
          maximum = Math.max(
            maximum,
            Math.abs(factory.sample(x, z, old(x, z), p) - old(x, z)) / epsilon,
          );
      }
      for (let x = p.minX; x <= p.maxX; x += 0.5) {
        for (const z of [p.minZ, p.maxZ])
          expect(factory.sample(x, z, old(x, z), p)).toBe(old(x, z));
        for (const z of [p.minZ + epsilon, p.maxZ - epsilon])
          maximum = Math.max(
            maximum,
            Math.abs(factory.sample(x, z, old(x, z), p) - old(x, z)) / epsilon,
          );
      }
      return maximum;
    };
    const coarse = boundary(0.01),
      medium = boundary(0.001),
      fine = boundary(0.0001);
    expect(medium).toBeLessThan(coarse * 0.11);
    expect(fine).toBeLessThan(medium * 0.11);
    expect(fine).toBeLessThan(0.001);
    expect(factory.sample(p.minX - 1, p.minZ - 1, -0, p)).toBe(-0);
  });

  it("eliminates the original nearest-segment discontinuity at an admitted crossing", () => {
    const input = originalRecipe();
    input.notch = [
      [285, 322],
      [290, 327],
      [285, 332],
      [290, 322],
    ];
    const factory = createCompactHavenShoulder(),
      p = factory.validate(input);
    // First and third segments cross here at different endpoint-fade weights.
    // Approaching along each segment made the former nearest-only rule select
    // different cuts even as both locations converge to the same point.
    const x = 285 + 10 / 3,
      z = 322 + 10 / 3,
      epsilon = 1e-7;
    const oldA = prototypeHeight(x + epsilon, z + epsilon, 40, input.notch);
    const oldB = prototypeHeight(x + epsilon, z - 2 * epsilon, 40, input.notch);
    expect(Math.abs(oldA - oldB)).toBeGreaterThan(0.1);
    const at = (x: number, z: number) => factory.sample(x, z, 40, p);
    const center = at(x, z);
    for (const e of [0.01, 0.001, 0.0001, 0.00001]) {
      for (const [dx, dz] of [
        [1, 1],
        [1, -2],
        [-1, -1],
        [-1, 2],
      ])
        expect(Math.abs(at(x + e * dx, z + e * dz) - center)).toBeLessThan(
          20 * e,
        );
    }
    expect(
      Math.abs(at(x + epsilon, z + epsilon) - at(x + epsilon, z - 2 * epsilon)),
    ).toBeLessThan(0.00001);
  });

  it("preserves the original prototype explicitly and matches current parameters in fresh/minified keepNames contexts", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../CompactHavenShoulder.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "HavenBundle",
      target: "es2022",
      minify: true,
      keepNames: true,
    });
    const minifiedSource = runInNewContext(
      `${result.outputFiles[0].text}\nHavenBundle.createCompactHavenShoulder.toString();`,
    ) as string;
    const local = createCompactHavenShoulder();
    const variants = [originalRecipe(), recipe()].map((input) => [
      { factory: local, descriptor: local.validate(input) },
      freshFactory(createCompactHavenShoulder.toString(), input),
      freshFactory(minifiedSource, input),
    ]);
    const landform = createCompactIslandLandform(createCompactHavenShoulder),
      noise = new NoiseGenerator(0);
    let samples = 0;
    for (let x = 270; x <= 316; x += 0.5)
      for (let z = 301; z <= 369; z += 0.5) {
        const old = landform.height(x, z, noise, baseline);
        for (const [index, contexts] of variants.entries()) {
          const expected =
            index === 0
              ? prototypeHeight(x, z, old)
              : contexts[0].factory.sample(x, z, old, contexts[0].descriptor);
          for (const { factory, descriptor } of contexts)
            expect(factory.sample(x, z, old, descriptor)).toBe(expected);
          expect(expected).toBeGreaterThanOrEqual(
            Math.min(old, prototype.grade),
          );
          expect(expected).toBeLessThanOrEqual(Math.max(old, 39));
        }
        samples++;
      }
    expect(samples).toBe(12741);
  }, 20000);
});
