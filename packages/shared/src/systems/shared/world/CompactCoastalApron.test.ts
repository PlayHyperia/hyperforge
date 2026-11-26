import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  createCompactCoastalApron,
  type CompactCoastalApron,
} from "./CompactCoastalApron";

// Unqualified art-brief inputs: these scalar tests do not prove final terrain,
// navigation, water, worker integration, rendered appearance or performance.
function recipe() {
  return {
    schemaVersion: 1,
    minX: 385,
    maxX: 499,
    minZ: 459,
    maxZ: 539,
    featherX: 18,
    featherZ: 16,
    halo: 1,
    floorHeight: 2.5,
    referencePlateau: 28.15,
    knots: [
      [-26, 2.5, 0],
      [-9, 16, 0.12],
      [3, 17.5, 0.14],
      [15, 19.25, 0.18],
      [45, 28.15, 0],
    ],
  };
}
const support = { minX: 384, maxX: 500, minZ: 458, maxZ: 540 };
const apron = createCompactCoastalApron();
const p = apron.validate(recipe());
function shoulderRecipe() {
  return {
    ...recipe(),
    minX: 445,
    maxX: 503,
    minZ: 436,
    featherX: 6,
    featherZ: 20,
    westernShoulder: { maxWidth: 24, startZ: 460, endZ: 539, featherZ: 24 },
  };
}
function lowlandRecipe() {
  return {
    ...shoulderRecipe(),
    lowland: {
      minZ: 436,
      maxZ: 540,
      startX: 462,
      endX: 422,
      descentLength: 57,
      halfWidth: 12,
      westHoldX: 445,
      westMinX: 377,
      westReleaseZ: 458,
      westReleaseLength: 64,
      eastMaxX: 503,
      startBlend: 12,
      endBlend: 22,
      endHeight: 18.3,
    },
  };
}
function headRecipe() {
  const c = Math.cos((48 * Math.PI) / 180),
    s = Math.sin((48 * Math.PI) / 180);
  return {
    ...lowlandRecipe(),
    headShoulder: {
      minX: 377,
      maxX: 444,
      minZ: 457,
      maxZ: 500,
      featherX: 8,
      featherZ: 6,
      start: [350 + 70 * c - 8 * s, 400 + 70 * s + 8 * c, 25.4] as [
        number,
        number,
        number,
      ],
      end: [350 + 94 * c - 8 * s, 400 + 94 * s + 8 * c, 19.2] as [
        number,
        number,
        number,
      ],
      leftWidth: 16,
      rightWidth: 24,
      startFade: 6,
      endFade: 5,
      leftSlope: 0.32,
      rightSlope: 0.18,
      creaseWidth: 1.2,
      blendHeight: 0.35,
    },
  };
}
function headReference(
  x: number,
  z: number,
  previous: number,
  p: CompactCoastalApron,
) {
  const h = p.headShoulder!;
  const angle = Math.atan2(h.end[1] - h.start[1], h.end[0] - h.start[0]);
  const length = Math.hypot(h.end[0] - h.start[0], h.end[1] - h.start[1]);
  const along =
    (x - h.start[0]) * Math.cos(angle) + (z - h.start[1]) * Math.sin(angle);
  const cross =
    (z - h.start[1]) * Math.cos(angle) - (x - h.start[0]) * Math.sin(angle);
  const t = Math.max(0, Math.min(1, along / length)),
    u = 1 - t;
  const rounded =
    Math.abs(cross) <= h.creaseWidth
      ? cross ** 2 / (2 * h.creaseWidth)
      : Math.abs(cross) - h.creaseWidth / 2;
  const target =
    (u ** 3 + 3 * u * u * t) * h.start[2] +
    (t ** 3 + 3 * t * t * u) * h.end[2] +
    (cross < 0 ? h.leftSlope : h.rightSlope) * rounded;
  const weight = [
    (x - h.minX) / h.featherX,
    (h.maxX - x) / h.featherX,
    (z - h.minZ) / h.featherZ,
    (h.maxZ - z) / h.featherZ,
    along / h.startFade,
    (length - along) / h.endFade,
    1 - Math.abs(cross) / (cross < 0 ? h.leftWidth : h.rightWidth),
  ].reduce((value, factor) => value * smooth(factor), 1);
  const delta = Math.max(0, previous - target);
  return {
    target,
    value: previous - (weight * delta ** 2) / (delta + h.blendHeight),
  };
}
function smooth(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function reference(q: number, spec: CompactCoastalApron): number {
  if (q <= spec.knots[0][0]) return 0;
  if (q >= spec.knots[4][0]) return 1;
  let i = 0;
  while (q > spec.knots[i + 1][0]) i++;
  const a = spec.knots[i],
    b = spec.knots[i + 1];
  const h = b[0] - a[0],
    t = (q - a[0]) / h,
    u = 1 - t;
  // Independent Bernstein-control-point evaluation in world-height units.
  const height =
    u * u * u * a[1] +
    3 * u * u * t * (a[1] + (h * a[2]) / 3) +
    3 * u * t * t * (b[1] - (h * b[2]) / 3) +
    t * t * t * b[1];
  return (
    (height - spec.floorHeight) / (spec.referencePlateau - spec.floorHeight)
  );
}

describe("isolated compact coastal apron", () => {
  it("owns optional head points deeply and includes their complete support halo without changing historical serialization", () => {
    const raw = headRecipe(),
      p = apron.validate(raw),
      h = p.headShoulder!;
    expect(h).toEqual(raw.headShoulder);
    expect(h).not.toBe(raw.headShoulder);
    expect(h.start).not.toBe(raw.headShoulder.start);
    expect(h.end).not.toBe(raw.headShoulder.end);
    for (const value of [p, h, h.start, h.end])
      expect(Object.isFrozen(value)).toBe(true);
    raw.headShoulder.start[2] = 28;
    raw.headShoulder.leftWidth = 40;
    expect(h.start[2]).toBe(25.4);
    expect(h.leftWidth).toBe(16);
    expect(apron.supportBounds(p).at(-1)).toEqual({
      minX: 377,
      maxX: 444,
      minZ: 457,
      maxZ: 500,
    });
    const expanded = apron.validate({
      ...headRecipe(),
      headShoulder: { ...headRecipe().headShoulder, minX: 370 },
    });
    const full = { minX: 369, maxX: 504, minZ: 435, maxZ: 541 };
    expect(() => apron.validateSupport(expanded, full, 1)).not.toThrow();
    expect(() =>
      apron.validateSupport(expanded, { ...full, minX: 369.001 }, 1),
    ).toThrow(/support/);
    for (const raw of [recipe(), shoulderRecipe(), lowlandRecipe()]) {
      const old = apron.validate(raw);
      expect(Object.prototype.hasOwnProperty.call(old, "headShoulder")).toBe(
        false,
      );
      expect(JSON.stringify(old)).toBe(JSON.stringify(raw));
    }
    expect(JSON.stringify(apron.validate(JSON.parse(JSON.stringify(p))))).toBe(
      JSON.stringify(p),
    );
  });

  it("rejects malformed head numeric ranges, tuples and records without invoking any accessors", () => {
    const raw = headRecipe(),
      h = raw.headShoulder;
    const patches: Record<string, unknown>[] = [
      { minX: NaN },
      { maxX: Infinity },
      { minX: 444 },
      { maxX: 506 },
      { maxZ: 472 },
      { maxZ: 600 },
      { featherX: 1.99 },
      { featherX: 34 },
      { featherZ: 22 },
      { leftWidth: 7.99 },
      { leftWidth: 40.01 },
      { rightWidth: 7.99 },
      { rightWidth: 40.01 },
      { startFade: 1.99 },
      { endFade: 1.99 },
      { startFade: 20 },
      { leftSlope: -0.01 },
      { leftSlope: 1.01 },
      { rightSlope: -0.01 },
      { rightSlope: 1.01 },
      { creaseWidth: 0.24 },
      { creaseWidth: 4.01 },
      { blendHeight: 0.049 },
      { blendHeight: 2.01 },
      { start: [376, 470, 25.4] },
      { end: [430, 501, 19.2] },
      { end: [...h.start] },
      { end: [h.start[0] + 2, h.start[1] + 2, 19.2] },
      { start: [...h.start.slice(0, 2), 28.16] },
      { end: [...h.end.slice(0, 2), 2.5] },
      { end: [...h.end.slice(0, 2), 25.5] },
      { start: [1, 2] },
      { end: [1, 2, 3, 4] },
      { start: new Float64Array(h.start) },
      { extra: 1 },
    ];
    for (const key of Object.keys(h)) {
      if (key === "start" || key === "end") continue;
      patches.push({ [key]: undefined }, { [key]: "1" }, { [key]: NaN });
    }
    for (const patch of patches)
      expect(() =>
        apron.validate({ ...raw, headShoulder: { ...h, ...patch } }),
      ).toThrow(/coastal apron/);
    for (const value of [
      undefined,
      null,
      false,
      [],
      {},
      Object.assign(Object.create({ extra: 1 }) as object, h),
    ])
      expect(() => apron.validate({ ...raw, headShoulder: value })).toThrow(
        /coastal apron/,
      );
    let reads = 0;
    const getter = () => {
      reads++;
      return 20;
    };
    const root = Object.defineProperty({ ...raw }, "headShoulder", {
      get: getter,
    });
    const nested = Object.defineProperty({ ...h }, "leftSlope", {
      get: getter,
    });
    const tuple = [...h.start];
    Object.defineProperty(tuple, "2", { get: getter });
    const sparse = [...h.end];
    delete sparse[1];
    for (const input of [
      root,
      { ...raw, headShoulder: nested },
      { ...raw, headShoulder: { ...h, start: tuple } },
      { ...raw, headShoulder: { ...h, end: sparse } },
      { ...raw, headShoulder: { ...h, [Symbol("extra")]: 1 } },
    ])
      expect(() => apron.validate(input)).toThrow(/coastal apron/);
    expect(reads).toBe(0);
  });

  it("rejects unowned mutable head data at sampling even outside support and admits frozen cross-factory transport", () => {
    const p = apron.validate(headRecipe()),
      h = p.headShoulder!;
    for (const value of [
      { ...p },
      Object.freeze({ ...p, headShoulder: { ...h } }),
      Object.freeze({
        ...p,
        headShoulder: Object.freeze({ ...h, start: [...h.start] }),
      }),
      Object.freeze({
        ...p,
        headShoulder: Object.freeze({ ...h, end: [...h.end] }),
      }),
    ])
      expect(() =>
        createCompactCoastalApron().sampleHead(
          0,
          0,
          28,
          value as CompactCoastalApron,
        ),
      ).toThrow(/mutable/);
    expect(createCompactCoastalApron().sampleHead(400, 468, 28, p)).toBe(
      apron.sampleHead(400, 468, 28, p),
    );
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => apron.sampleHead(value, 468, 28, p)).toThrow(/head sample/);
      expect(() => apron.sampleHead(400, value, 28, p)).toThrow(/head sample/);
      expect(() => apron.sampleHead(400, 468, value, p)).toThrow(/head sample/);
    }
  });

  it("keeps omission, exterior, sea and untouched bay arithmetic bit-exact", () => {
    const old = apron.validate(lowlandRecipe()),
      p = apron.validate(headRecipe());
    for (const previous of [-0, 0, 16, 19.2, 28, NaN]) {
      expect(Object.is(apron.sampleHead(NaN, NaN, previous), previous)).toBe(
        true,
      );
      expect(
        Object.is(apron.sampleHead(NaN, NaN, previous, old), previous),
      ).toBe(true);
    }
    for (const [x, z] of [
      [376, 468],
      [377, 468],
      [444, 468],
      [445, 468],
      [400, 457],
      [400, 500],
      [466, 483],
    ])
      for (const previous of [-0, 0, 16, 19.2, 28])
        expect(Object.is(apron.sampleHead(x, z, previous, p), previous)).toBe(
          true,
        );
    for (let x = 378; x < 444; x += 8)
      for (let z = 458; z < 500; z += 8) {
        for (const previous of [-0, 0, 2.5, 16, 19.2])
          expect(Object.is(apron.sampleHead(x, z, previous, p), previous)).toBe(
            true,
          );
        for (const coast of [0.2, 0.8, 1])
          expect(apron.blendBay(x, z, 3, 0.31, p, coast)).toBe(
            apron.blendBay(x, z, 3, 0.31, old, coast),
          );
      }
  });

  it("matches independent rotated Bernstein/soft-cut evaluation and bounds every lowering", () => {
    const p = apron.validate(headRecipe());
    let changed = 0;
    for (let x = 377; x <= 444; x += 3)
      for (let z = 457; z <= 500; z += 3)
        for (const previous of [16, 19.2, 22, 25.4, 28.15, 40]) {
          const actual = apron.sampleHead(x, z, previous, p),
            expected = headReference(x, z, previous, p);
          expect(actual).toBeCloseTo(expected.value, 12);
          expect(actual).toBeLessThanOrEqual(previous);
          expect(actual).toBeGreaterThanOrEqual(
            Math.min(previous, expected.target),
          );
          expect(actual).toBeGreaterThanOrEqual(
            Math.min(previous, p.headShoulder!.end[2]),
          );
          changed += actual < previous ? 1 : 0;
        }
    expect(changed).toBeGreaterThan(100);
    expect(apron.sampleHead(400, 468, 28, p)).toBeLessThan(26);
    expect(
      Number.isFinite(apron.sampleHead(400, 468, Number.MAX_VALUE, p)),
    ).toBe(true);
  });

  it("has C1 rectangular, along, asymmetric side, crease and soft-cut joins", () => {
    const raw = headRecipe();
    const p = apron.validate({
      ...raw,
      headShoulder: {
        ...raw.headShoulder,
        minX: 0,
        maxX: 64,
        minZ: 0,
        maxZ: 64,
        featherX: 8,
        featherZ: 4,
        start: [0, 32, 25.4],
        end: [64, 32, 19.2],
      },
    });
    const sample = (x: number, z: number) => apron.sampleHead(x, z, 28, p),
      eps = 1e-5;
    for (const [x, z] of [
      [0, 32],
      [64, 32],
      [6, 32],
      [59, 32],
      [8, 32],
      [56, 32],
      [32, 32],
      [32, 30.8],
      [32, 33.2],
      [32, 16],
      [32, 56],
    ]) {
      const value = sample(x, z);
      for (const [dx, dz] of [
        [eps, 0],
        [0, eps],
      ])
        expect(
          Math.abs(
            (value - sample(x - dx, z - dz)) / eps -
              (sample(x + dx, z + dz) - value) / eps,
          ),
        ).toBeLessThan(2e-4);
    }
    const clipped = apron.validate({
      ...p,
      headShoulder: { ...p.headShoulder!, minZ: 20, maxZ: 44 },
    });
    for (const z of [20, 24, 40, 44]) {
      const value = apron.sampleHead(32, z, 28, clipped);
      const left = (value - apron.sampleHead(32, z - eps, 28, clipped)) / eps;
      const right = (apron.sampleHead(32, z + eps, 28, clipped) - value) / eps;
      expect(Math.abs(left - right)).toBeLessThan(2e-4);
    }
    const target = 22.3,
      center = apron.sampleHead(32, 32, target, p);
    expect(center).toBe(target);
    expect(
      (center - apron.sampleHead(32, 32, target - eps, p)) / eps,
    ).toBeCloseTo(1, 4);
    expect(
      (apron.sampleHead(32, 32, target + eps, p) - center) / eps,
    ).toBeCloseTo(1, 4);
    expect(sample(32, 26)).not.toBe(sample(32, 38));
  });

  it("emits the actual head factory into a fresh realm without dependencies or a mutation escape", () => {
    const raw = headRecipe(),
      p = apron.validate(raw);
    const actual = runInNewContext(
      `const op=(${createCompactCoastalApron.toString()})();const p=op.validate(${JSON.stringify(raw)});({sample:(x,z,h)=>op.sampleHead(x,z,h,p),bounds:op.supportBounds(p),frozen:Object.isFrozen(p.headShoulder)&&Object.isFrozen(p.headShoulder.start)&&Object.isFrozen(p.headShoulder.end)})`,
    ) as {
      sample(x: number, z: number, h: number): number;
      bounds: unknown;
      frozen: boolean;
    };
    expect(actual.frozen).toBe(true);
    expect(actual.bounds).toEqual(apron.supportBounds(p));
    for (const [x, z] of [
      [377, 468],
      [444, 468],
      [400, 457],
      [400, 500],
      [390, 460],
      [400, 468],
      [406, 471],
      [410, 480],
      [466, 483],
    ])
      for (const previous of [-0, 0, 16, 19.2, 22, 28, 40])
        expect(
          Object.is(
            actual.sample(x, z, previous),
            apron.sampleHead(x, z, previous, p),
          ),
        ).toBe(true);
  });

  it("owns the bounded lowland descriptor and keeps omitted historical recipes exact", () => {
    const raw = lowlandRecipe(),
      p = apron.validate(raw);
    expect(p.lowland).toEqual(raw.lowland);
    expect(p.lowland).not.toBe(raw.lowland);
    expect(Object.isFrozen(p.lowland)).toBe(true);
    raw.lowland.endHeight = 20;
    expect(p.lowland!.endHeight).toBe(18.3);
    expect(apron.supportBounds(p).slice(-2)).toEqual([
      { minX: 445, maxX: 503, minZ: 436, maxZ: 458 },
      { minX: 377, maxX: 503, minZ: 458, maxZ: 540 },
    ]);
    expect(() =>
      apron.validateSupport(
        p,
        { minX: 376, maxX: 504, minZ: 435, maxZ: 541 },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      apron.validateSupport(
        p,
        { minX: 376.01, maxX: 504, minZ: 435, maxZ: 541 },
        1,
      ),
    ).toThrow(/support/);
    const prior = apron.validate(shoulderRecipe());
    expect(Object.prototype.hasOwnProperty.call(prior, "lowland")).toBe(false);
    for (const [x, z] of [
      [440, 470],
      [450, 480],
      [490, 490],
    ])
      expect(apron.blendBay(x, z, 3, 0.31, prior, 0.2)).toBe(
        apron.blendBay(x, z, 3, 0.31, prior),
      );
    expect(
      createCompactCoastalApron().blendBay(450, 480, 3, 0.31, p, 0.8),
    ).toBe(apron.blendBay(450, 480, 3, 0.31, p, 0.8));
  });
  it("matches independent Bernstein descent, curved area and quadratic coast cap", () => {
    const p = apron.validate(lowlandRecipe()),
      l = p.lowland!;
    for (let z = 435; z <= 541; z += 2.5)
      for (let x = 375; x <= 505; x += 4)
        for (const coast of [0.2, 0.8, 1]) {
          const r = smooth((z - 458) / 64),
            center = 462 - 40 * r,
            west = 445 - 68 * r;
          const u = Math.max(0, Math.min(1, (z - 436) / 57)),
            v = 1 - u;
          // Cubic Bezier heights: horizontal start, downstream slope equal to
          // the mean descent. This is not the implementation's power basis.
          const h =
            v * v * v * 28.15 +
            3 * v * v * u * 28.15 +
            3 * v * u * u * (18.3 - (18.3 - 28.15) / 3) +
            u * u * u * 18.3 +
            Math.max(0, (z - 436) / 57 - 1) * (18.3 - 28.15);
          const desired = Math.max(0, (h - 2.5) / (25.65 * coast));
          const t = (desired - 0.9) / 0.2;
          const cap =
            desired <= 0.9
              ? desired
              : desired >= 1.1
                ? 1
                : (1 - t) * (1 - t) * 0.9 + 2 * (1 - t) * t + t * t;
          const weight =
            smooth((x - west) / (center - 12 - west)) *
            smooth((503 - x) / (503 - center - 12)) *
            smooth((z - 436) / 12) *
            smooth((540 - z) / 22);
          const expected = 0.31 + weight * (cap - 0.31);
          const actual = apron.blendBay(x, z, -12, 0.31, p, coast);
          expect(actual).toBeCloseTo(expected, 12);
          expect(actual).toBeGreaterThanOrEqual(0);
          expect(actual).toBeLessThanOrEqual(1);
          // q and the historical shoulder no longer shape the selected lowland.
          expect(actual).toBe(apron.blendBay(x, z, 24, 0.31, p, coast));
        }
    expect(l.halfWidth * 2).toBe(24);
  });
  it("retains C1 field boundaries and descent/bend joins without reopening the outer coast", () => {
    const p = apron.validate(lowlandRecipe());
    const sample = (x: number, z: number) =>
      apron.blendBay(x, z, 3, 0.31, p, 0.8);
    const h = 1e-4;
    for (const [x, z] of [
      [460, 436],
      [420, 540],
      [440, 458],
      [420, 493],
      [420, 522],
      [503, 480],
    ]) {
      const value = sample(x, z);
      for (const [dx, dz] of [
        [h, 0],
        [0, h],
      ]) {
        const left = (value - sample(x - dx, z - dz)) / h;
        const right = (sample(x + dx, z + dz) - value) / h;
        expect(Math.abs(left - right)).toBeLessThan(1e-4);
      }
    }
    for (const bad of [0, -0.1, 1.01, NaN, Infinity])
      expect(() => apron.blendBay(450, 480, 3, 0.31, p, bad)).toThrow(
        /outer coast/,
      );
  });
  it("rejects malformed lowland data without reading accessors and survives fresh-realm emission", () => {
    const raw = lowlandRecipe();
    let reads = 0;
    const getter = Object.defineProperty({ ...raw.lowland }, "endHeight", {
      enumerable: true,
      get() {
        reads++;
        return 18;
      },
    });
    for (const lowland of [
      undefined,
      null,
      false,
      {},
      getter,
      { ...raw.lowland, extra: 1 },
      { ...raw.lowland, halfWidth: 0 },
      { ...raw.lowland, endHeight: 29 },
      { ...raw.lowland, endHeight: 3 },
      { ...raw.lowland, westReleaseLength: 0 },
      { ...raw.lowland, westMinX: 422 },
      { ...raw.lowland, startX: Infinity },
      { ...raw.lowland, descentLength: 200 },
    ])
      expect(() => apron.validate({ ...raw, lowland })).toThrow(
        /coastal apron/,
      );
    expect(reads).toBe(0);
    const p = apron.validate(raw);
    const mutable = Object.freeze({ ...p, lowland: { ...p.lowland! } });
    expect(() =>
      createCompactCoastalApron().blendBay(450, 480, 3, 0.31, mutable, 0.8),
    ).toThrow(/mutable/);
    const actual = runInNewContext(
      `const op=(${createCompactCoastalApron.toString()})();const p=op.validate(${JSON.stringify(raw)});(x,z,coast)=>op.blendBay(x,z,3,.31,p,coast)`,
    ) as (x: number, z: number, coast: number) => number;
    for (const [x, z] of [
      [460, 450],
      [440, 480],
      [420, 510],
      [380, 530],
    ])
      for (const coast of [0.2, 0.8, 1])
        expect(actual(x, z, coast)).toBe(
          apron.blendBay(x, z, 3, 0.31, p, coast),
        );
  });
  it("owns optional western shoulder data and validates its full bounded support union/halo", () => {
    const input = shoulderRecipe(),
      current = apron.validate(input);
    expect(current.westernShoulder).toEqual(input.westernShoulder);
    expect(current.westernShoulder).not.toBe(input.westernShoulder);
    expect(Object.isFrozen(current.westernShoulder)).toBe(true);
    input.westernShoulder.maxWidth = 100;
    expect(current.westernShoulder!.maxWidth).toBe(24);
    const support = apron.supportBounds(current);
    expect(support).toEqual([
      { minX: 445, maxX: 503, minZ: 436, maxZ: 539 },
      { minX: 427, maxX: 451, minZ: 460, maxZ: 539 },
    ]);
    expect(Object.isFrozen(support)).toBe(true);
    expect(support.every(Object.isFrozen)).toBe(true);
    const full = { minX: 426, maxX: 504, minZ: 435, maxZ: 540 };
    expect(() => apron.validateSupport(current, full, 1)).not.toThrow();
    expect(() =>
      apron.validateSupport(current, { ...full, minX: 426.001 }, 1),
    ).toThrow(/support/);
    expect(() =>
      apron.validateSupport(current, { ...full, minX: 444 }, 1),
    ).toThrow(/support/);
    const { westernShoulder: _removed, ...oldInput } = shoulderRecipe();
    const old = apron.validate(oldInput);
    expect(Object.prototype.hasOwnProperty.call(old, "westernShoulder")).toBe(
      false,
    );
    expect(JSON.stringify(old)).toBe(JSON.stringify(oldInput));
    expect(apron.supportBounds(old)).toHaveLength(1);
  });

  it("matches an independent curved-width formula and preserves the full-strength interior exactly", () => {
    const input = shoulderRecipe(),
      current = apron.validate(input);
    const { westernShoulder: _removed, ...oldInput } = input,
      old = apron.validate(oldInput);
    for (let z = 435; z <= 540; z += 2.5)
      for (let x = 426; x <= 504; x += 2.5)
        for (const q of [-30, -9, 3, 20, 50]) {
          const previous = 0.31;
          const width =
            6 + 18 * smooth((z - 460) / 24) * smooth((539 - z) / 24);
          const west = 451 - width;
          const weight =
            smooth((x - west) / width) *
            smooth((503 - x) / 6) *
            smooth((z - 436) / 20) *
            smooth((539 - z) / 20);
          const expected =
            previous + weight * (reference(q, current) - previous);
          const actual = apron.blendBay(x, z, q, previous, current);
          expect(actual).toBeCloseTo(expected, 13);
          if (x >= 451 || z <= 460 || z >= 539)
            expect(actual).toBe(apron.blendBay(x, z, q, previous, old));
          expect(actual).toBeGreaterThanOrEqual(0);
          expect(actual).toBeLessThanOrEqual(1);
        }
  });

  it("keeps C1 joins at both ends, the curved outer edge and the fixed inner edge", () => {
    const input = shoulderRecipe(),
      current = apron.validate(input);
    const { westernShoulder: _removed, ...oldInput } = input,
      old = apron.validate(oldInput);
    const h = 1e-4,
      q = 3,
      previous = 0.31;
    const delta = (x: number, z: number) =>
      apron.blendBay(x, z, q, previous, current) -
      apron.blendBay(x, z, q, previous, old);
    for (const z of [460, 539])
      for (const x of [427, 435, 445, 450, 451, 470]) {
        expect(delta(x, z)).toBe(0);
        expect(
          Math.abs((delta(x, z + h) - delta(x, z - h)) / (2 * h)),
        ).toBeLessThan(1e-5);
      }
    for (const z of [470, 484, 500, 515, 530]) {
      const width = 6 + 18 * smooth((z - 460) / 24) * smooth((539 - z) / 24),
        west = 451 - width;
      expect(apron.blendBay(west, z, q, previous, current)).toBe(previous);
      expect(
        Math.abs(
          (apron.blendBay(west + h, z, q, previous, current) - previous) / h,
        ),
      ).toBeLessThan(1e-5);
      expect(delta(451, z)).toBe(0);
      expect(
        Math.abs((delta(451 + h, z) - delta(451 - h, z)) / (2 * h)),
      ).toBeLessThan(1e-5);
    }
  });

  it("rejects malformed optional shoulder fields and mutable/accessor transport without reading getters", () => {
    const input = shoulderRecipe();
    for (const westernShoulder of [
      undefined,
      null,
      false,
      {},
      { ...input.westernShoulder, maxWidth: 5 },
      { ...input.westernShoulder, maxWidth: 129 },
      { ...input.westernShoulder, startZ: 435 },
      { ...input.westernShoulder, endZ: 540 },
      { ...input.westernShoulder, featherZ: 40 },
      { ...input.westernShoulder, featherZ: 1 },
      { ...input.westernShoulder, maxWidth: NaN },
      { ...input.westernShoulder, extra: 1 },
    ])
      expect(() => apron.validate({ ...input, westernShoulder })).toThrow(
        /coastal apron/,
      );
    let reads = 0;
    const rootGetter = Object.defineProperty({ ...input }, "westernShoulder", {
      get() {
        reads++;
        return input.westernShoulder;
      },
    });
    const nestedGetter = Object.defineProperty(
      { ...input.westernShoulder },
      "maxWidth",
      {
        get() {
          reads++;
          return 24;
        },
      },
    );
    const inherited = Object.assign(Object.create({ maxWidth: 24 }) as object, {
      startZ: 460,
      endZ: 539,
      featherZ: 24,
    });
    for (const value of [
      rootGetter,
      { ...input, westernShoulder: nestedGetter },
      { ...input, westernShoulder: inherited },
    ])
      expect(() => apron.validate(value)).toThrow(/coastal apron/);
    expect(reads).toBe(0);
    const current = apron.validate(input);
    const mutableNested = Object.freeze({
      ...current,
      westernShoulder: { ...current.westernShoulder! },
    });
    expect(() =>
      createCompactCoastalApron().blendBay(440, 490, 3, 0.3, mutableNested),
    ).toThrow(/mutable/);
    const other = createCompactCoastalApron();
    expect(other.blendBay(440, 490, 3, 0.3, current)).toBe(
      apron.blendBay(440, 490, 3, 0.3, current),
    );
    const actual = runInNewContext(
      `const a=(${createCompactCoastalApron.toString()})();const p=a.validate(${JSON.stringify(input)});({value:a.blendBay(440,490,3,.3,p),bounds:a.supportBounds(p)});`,
    ) as { value: number; bounds: unknown };
    expect(actual.value).toBe(apron.blendBay(440, 490, 3, 0.3, current));
    expect(actual.bounds).toEqual(apron.supportBounds(current));
  });

  it("owns a canonical deeply frozen five-knot recipe without mutating its input", () => {
    const input = recipe();
    const result = apron.validate(input);
    expect(result).toEqual(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.knots)).toBe(true);
    expect(result.knots.every(Object.isFrozen)).toBe(true);
    expect(result.knots).not.toBe(input.knots);
    expect(result.knots[1]).not.toBe(input.knots[1]);
    const before = apron.section(-5, result);
    input.knots[1][1] = 500;
    input.minX = 0;
    expect(apron.section(-5, result)).toBe(before);
    expect(result.minX).toBe(385);
    expect(
      JSON.stringify(apron.validate(JSON.parse(JSON.stringify(result)))),
    ).toBe(JSON.stringify(result));
  });

  it("matches independent Bernstein evaluation, knot values and bounded monotonic sections", () => {
    let previous = -1;
    for (let i = -1100; i <= 1900; i++) {
      const q = i / 40;
      const actual = apron.section(q, p);
      expect(actual).toBeGreaterThanOrEqual(0);
      expect(actual).toBeLessThanOrEqual(1);
      expect(actual).toBeGreaterThanOrEqual(previous);
      expect(actual).toBeCloseTo(reference(q, p), 13);
      previous = actual;
    }
    for (const [q, height] of p.knots)
      expect(apron.section(q, p)).toBeCloseTo(
        (height - p.floorHeight) / (p.referencePlateau - p.floorHeight),
        14,
      );
    expect(apron.section(-512, p)).toBe(0);
    expect(apron.section(512, p)).toBe(1);
  });

  it("meets both one-sided authored derivatives at all five joins", () => {
    const h = 1e-5,
      relief = p.referencePlateau - p.floorHeight;
    for (const [q, , tangent] of p.knots) {
      const value = apron.section(q, p);
      const left = (value - apron.section(q - h, p)) / h;
      const right = (apron.section(q + h, p) - value) / h;
      expect(Math.abs(left - tangent / relief)).toBeLessThan(2e-7);
      expect(Math.abs(right - tangent / relief)).toBeLessThan(2e-7);
    }
  });

  it("returns absent/outside factors bit-exactly, including signed zero", () => {
    for (const value of [-0, 0, 0.3, 1, NaN])
      expect(Object.is(apron.blendBay(NaN, NaN, NaN, value), value)).toBe(true);
    for (const [x, z] of [
      [384, 500],
      [385, 500],
      [499, 500],
      [500, 500],
      [440, 458],
      [440, 459],
      [440, 539],
      [440, 540],
    ])
      for (const value of [-0, 0, 0.3, 1])
        expect(Object.is(apron.blendBay(x, z, -9, value, p), value)).toBe(true);
  });

  it("has a C1 compact spatial collar and a full-strength interior", () => {
    const old = 0.17,
      q = 3,
      h = 1e-4;
    expect(apron.blendBay(440, 500, q, old, p)).toBeCloseTo(
      apron.section(q, p),
      15,
    );
    for (const [x, z, dx, dz] of [
      [385, 500, 1, 0],
      [499, 500, -1, 0],
      [440, 459, 0, 1],
      [440, 539, 0, -1],
    ]) {
      expect(apron.blendBay(x, z, q, old, p)).toBe(old);
      expect(
        Math.abs((apron.blendBay(x + dx * h, z + dz * h, q, old, p) - old) / h),
      ).toBeLessThan(1e-6);
    }
    for (const [x, z, dx, dz] of [
      [403, 500, 1, 0],
      [481, 500, 1, 0],
      [440, 475, 0, 1],
      [440, 523, 0, 1],
    ]) {
      const left = apron.blendBay(x - dx * h, z - dz * h, q, old, p);
      const right = apron.blendBay(x + dx * h, z + dz * h, q, old, p);
      expect(Math.abs((right - left) / (2 * h))).toBeLessThan(1e-6);
    }
    for (let x = 384; x <= 500; x += 4)
      for (let z = 458; z <= 540; z += 4)
        for (const q of [-30, -20, -9, 3, 20, 50])
          for (const previous of [0, 0.31, 1]) {
            const actual = apron.blendBay(x, z, q, previous, p);
            expect(actual).toBeGreaterThanOrEqual(0);
            expect(actual).toBeLessThanOrEqual(1);
          }
  });

  it("admits the exact canonical halo and rejects escaped or undersized support", () => {
    expect(() => apron.validateSupport(p, support, 1)).not.toThrow();
    for (const box of [
      { ...support, minX: 384.001 },
      { ...support, maxX: 499.999 },
      { ...support, minZ: 458.001 },
      { ...support, maxZ: 539.999 },
      { ...support, minX: 600 },
      { ...support, minX: NaN },
    ])
      expect(() => apron.validateSupport(p, box, 1)).toThrow(/coastal apron/);
    for (const distance of [1.001, -1, NaN, Infinity])
      expect(() => apron.validateSupport(p, support, distance)).toThrow(
        /coastal apron/,
      );
    const next = apron.validate({ ...recipe(), halo: 2 });
    expect(() => apron.validateSupport(next, support, 1)).toThrow(/support/);
  });

  it("rejects non-monotone interior derivatives even when heights and endpoint tangents increase", () => {
    const input = recipe();
    input.knots[1][2] = 1;
    input.knots[2][2] = 1;
    expect(() => apron.validate(input)).toThrow(/non-monotone/);
  });

  it.each([
    { schemaVersion: 2 },
    { halo: 0 },
    { halo: 17 },
    { minX: Infinity },
    { maxX: 385 },
    { maxX: 100000 },
    { featherX: 1 },
    { featherZ: 41 },
    { floorHeight: 29 },
    { referencePlateau: 2.5 },
    { knots: undefined },
    { knots: [] },
    { knots: recipe().knots.slice(1) },
    { unexpected: 1 },
  ])("rejects malformed recipe patch %j", (patch) => {
    expect(() => apron.validate({ ...recipe(), ...patch })).toThrow(
      /coastal apron/,
    );
  });

  it.each([
    [0, 0, 0],
    [0, 1, 3],
    [0, 2, 0.01],
    [1, 0, -26],
    [1, 1, 2.5],
    [2, 0, NaN],
    [2, 1, Infinity],
    [2, 2, -0.1],
    [4, 1, 28],
    [4, 2, 0.01],
  ])("rejects malformed knot [%i][%i]=%s", (index, field, value) => {
    const input = recipe();
    input.knots[index][field] = value;
    expect(() => apron.validate(input)).toThrow(/coastal apron/);
  });

  it("rejects inherited/accessor/symbol/sparse payloads without invoking accessors", () => {
    let reads = 0;
    const rootGetter = Object.defineProperty(recipe(), "minX", {
      get() {
        reads++;
        return 385;
      },
    });
    const knotGetter = recipe();
    Object.defineProperty(knotGetter.knots[1], "1", {
      get() {
        reads++;
        return 16;
      },
    });
    const sparse = recipe();
    delete sparse.knots[2][1];
    const symbol = { ...recipe(), [Symbol("extra")]: 1 };
    const inherited = Object.assign(
      Object.create({ field: 1 }) as object,
      recipe(),
    );
    for (const input of [
      rootGetter,
      knotGetter,
      sparse,
      symbol,
      inherited,
      null,
      false,
    ])
      expect(() => apron.validate(input)).toThrow(/coastal apron/);
    expect(reads).toBe(0);
  });

  it("admits other factories' immutable recipes but rejects mutable sampling descriptors", () => {
    const other = createCompactCoastalApron();
    expect(other.section(2, p)).toBe(apron.section(2, p));
    const mutable = recipe() as unknown as CompactCoastalApron;
    expect(() => other.section(2, mutable)).toThrow(/mutable/);
    expect(() => other.blendBay(0, 0, 2, 0.4, mutable)).toThrow(/mutable/);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => apron.section(value, p)).toThrow(/finite/);
      expect(() => apron.blendBay(value, 500, 2, 0.4, p)).toThrow(/sample/);
    }
    expect(() => apron.blendBay(440, 500, 2, 1.1, p)).toThrow(/sample/);
  });

  it("executes the actual factory in a fresh realm with no module dependencies", () => {
    const actual = runInNewContext(`
      const operations = (${createCompactCoastalApron.toString()})();
      const recipe = operations.validate(${JSON.stringify(recipe())});
      operations.validateSupport(recipe, ${JSON.stringify(support)}, 1);
      ({ section: q => operations.section(q, recipe),
         blend: (x,z,q,old) => operations.blendBay(x,z,q,old,recipe) });
    `) as {
      section(q: number): number;
      blend(x: number, z: number, q: number, old: number): number;
    };
    for (let q = -30; q <= 50; q += 0.37) {
      expect(actual.section(q)).toBe(apron.section(q, p));
      for (const [x, z] of [
        [385, 459],
        [390, 463],
        [440, 500],
        [495, 535],
      ])
        expect(actual.blend(x, z, q, 0.2)).toBe(
          apron.blendBay(x, z, q, 0.2, p),
        );
    }
  });
});
