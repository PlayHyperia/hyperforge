export type CompactHavenShoulder = Readonly<{
  schemaVersion: 1;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  grade: number;
  westFade: number;
  eastFade: number;
  northFade: number;
  southFade: number;
  crestWidth: number;
  faceRun: number;
  shelfMinWidth: number;
  faceChamfer: number;
  notchDepth: number;
  notchWidth: number;
  notchEndFade: number;
  /** Tuples are world X, world Z, absolute height, with shared increasing Z knots. */
  crest: readonly (readonly [number, number, number])[];
  shelf: readonly (readonly [number, number, number])[];
  toe: readonly (readonly [number, number, number])[];
  notch: readonly (readonly [number, number])[];
}>;

/**
 * Bounded art-directed rock faces, meadow shelf and drainage notch. This factory
 * is embedded verbatim in terrain/grass workers; no runtime imports or globals.
 * Validation compiles immutable curves once. Sampling allocates nothing.
 * The outer collar is C1; nearest-polyline drainage and the grade floor can
 * contain internal derivative creases. This is not a navigation policy.
 */
export function createCompactHavenShoulder() {
  type Curve = {
    points: CompactHavenShoulder["crest"];
    xTangents: readonly number[];
    yTangents: readonly number[];
  };
  type Segment = {
    x: number;
    z: number;
    dx: number;
    dz: number;
    length: number;
    along: number;
  };
  type Compiled = {
    crest: Curve;
    shelf: Curve;
    toe: Curve;
    segments: readonly Segment[];
    length: number;
  };
  const cache = new WeakMap<CompactHavenShoulder, Compiled>();
  const operations = {
    fail(field: string): never {
      throw new Error(`Invalid compact Haven shoulder: ${field}`);
    },
    keys(
      value: unknown,
      expected: readonly string[],
      array = false,
    ): Record<string, unknown> {
      if (!value || typeof value !== "object" || Array.isArray(value) !== array)
        return operations.fail("record/array");
      const prototype = Object.getPrototypeOf(value);
      if (
        array
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        operations.fail("prototype");
      const actual = Reflect.ownKeys(value);
      if (
        actual.length !== expected.length ||
        actual.some((k) => typeof k !== "string" || !expected.includes(k))
      )
        operations.fail("keys");
      if (
        Object.values(Object.getOwnPropertyDescriptors(value)).some(
          (d) => !("value" in d),
        )
      )
        operations.fail("accessors");
      return value as Record<string, unknown>;
    },
    finite(value: unknown): number {
      if (typeof value !== "number" || !Number.isFinite(value))
        return operations.fail("finite number");
      return value === 0 ? 0 : value;
    },
    array(value: unknown, min: number, max: number): readonly unknown[] {
      if (!Array.isArray(value) || value.length < min || value.length > max)
        return operations.fail("array length");
      operations.keys(
        value,
        [
          ...Array.from({ length: value.length }, (_, i) => String(i)),
          "length",
        ],
        true,
      );
      return value;
    },
    smooth(value: number): number {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    },
    mix(a: number, b: number, t: number): number {
      return a + (b - a) * t;
    },
    tangents(
      points: CompactHavenShoulder["crest"],
      field: 0 | 2,
    ): readonly number[] {
      return points.map((point, j) => {
        if (j === 0 || j === points.length - 1) return 0;
        const h0 = point[1] - points[j - 1][1],
          h1 = points[j + 1][1] - point[1];
        const a = (point[field] - points[j - 1][field]) / h0;
        const b = (points[j + 1][field] - point[field]) / h1;
        if (a * b <= 0) return 0;
        const w0 = 2 * h1 + h0,
          w1 = h1 + 2 * h0;
        return (w0 + w1) / (w0 / a + w1 / b);
      });
    },
    compileCurve(points: CompactHavenShoulder["crest"]): Curve {
      return {
        points,
        xTangents: operations.tangents(points, 0),
        yTangents: operations.tangents(points, 2),
      };
    },
    curve(c: Curve, z: number, field: 0 | 2): number {
      const points = c.points,
        last = points.length - 1;
      if (z <= points[0][1]) return points[0][field];
      if (z >= points[last][1]) return points[last][field];
      let i = 0;
      while (z > points[i + 1][1]) i++;
      const h = points[i + 1][1] - points[i][1],
        t = (z - points[i][1]) / h;
      const m = field === 0 ? c.xTangents : c.yTangents;
      // Retain scalar basis evaluation/order across the CPU and emitted workers.
      return (
        (2 * t * t * t - 3 * t * t + 1) * points[i][field] +
        (t * t * t - 2 * t * t + t) * h * m[i] +
        (-2 * t * t * t + 3 * t * t) * points[i + 1][field] +
        (t * t * t - t * t) * h * m[i + 1]
      );
    },
    plane(value: number, r: number): number {
      const t = Math.max(0, Math.min(1, value));
      if (t < r) return (t * t) / (2 * r * (1 - r));
      if (t > 1 - r) return 1 - ((1 - t) * (1 - t)) / (2 * r * (1 - r));
      return (t - r / 2) / (1 - r);
    },
    triples(value: unknown): CompactHavenShoulder["crest"] {
      return Object.freeze(
        operations
          .array(value, 2, 16)
          .map(
            (point) =>
              Object.freeze(
                operations.array(point, 3, 3).map(operations.finite),
              ) as readonly [number, number, number],
          ),
      );
    },
    minX(points: CompactHavenShoulder["crest"]): number {
      return Math.min(...points.map((point) => point[0]));
    },
    maxX(points: CompactHavenShoulder["crest"]): number {
      return Math.max(...points.map((point) => point[0]));
    },
    validate(input: unknown): CompactHavenShoulder {
      const names = [
        "minX",
        "maxX",
        "minZ",
        "maxZ",
        "grade",
        "westFade",
        "eastFade",
        "northFade",
        "southFade",
        "crestWidth",
        "faceRun",
        "shelfMinWidth",
        "faceChamfer",
        "notchDepth",
        "notchWidth",
        "notchEndFade",
      ] as const;
      const data = operations.keys(input, [
        "schemaVersion",
        ...names,
        "crest",
        "shelf",
        "toe",
        "notch",
      ]);
      if (data.schemaVersion !== 1) operations.fail("schemaVersion");
      const numbers = Object.fromEntries(
        names.map((n) => [n, operations.finite(data[n])]),
      ) as Record<(typeof names)[number], number>;
      const p: CompactHavenShoulder = Object.freeze({
        schemaVersion: 1,
        ...numbers,
        crest: operations.triples(data.crest),
        shelf: operations.triples(data.shelf),
        toe: operations.triples(data.toe),
        notch: Object.freeze(
          operations
            .array(data.notch, 2, 16)
            .map(
              (v) =>
                Object.freeze(
                  operations.array(v, 2, 2).map(operations.finite),
                ) as readonly [number, number],
            ),
        ),
      });
      const width = p.maxX - p.minX,
        depth = p.maxZ - p.minZ;
      if (
        Math.max(
          Math.abs(p.minX),
          Math.abs(p.maxX),
          Math.abs(p.minZ),
          Math.abs(p.maxZ),
        ) > 10000 ||
        width < 16 ||
        width > 96 ||
        depth < 16 ||
        depth > 128 ||
        Math.abs(p.grade) > 1000 ||
        p.westFade < 2 ||
        p.eastFade < 2 ||
        p.westFade + p.eastFade > width ||
        p.northFade < 2 ||
        p.southFade < 2 ||
        p.northFade + p.southFade > depth ||
        p.crestWidth < 1 ||
        p.crestWidth > 6 ||
        p.faceRun < 2 ||
        p.faceRun > 16 ||
        p.shelfMinWidth < 1 ||
        p.shelfMinWidth > 8 ||
        p.faceChamfer < 0.1 ||
        p.faceChamfer > 0.4 ||
        p.notchDepth < 0 ||
        p.notchDepth > 6 ||
        p.notchWidth < 2 ||
        p.notchWidth > 8 ||
        p.notchEndFade < 2 ||
        p.notchEndFade > 16
      )
        operations.fail("shape ranges");
      for (const points of [p.crest, p.shelf, p.toe]) {
        if (points.length !== p.crest.length) operations.fail("shared knots");
        for (let i = 0; i < points.length; i++) {
          const [x, z, y] = points[i];
          if (
            x <= p.minX ||
            x >= p.maxX ||
            z <= p.minZ ||
            z >= p.maxZ ||
            y < p.grade ||
            y > p.grade + 24 ||
            z !== p.crest[i][1] ||
            (i > 0 && z - points[i - 1][1] < 2)
          )
            operations.fail("curve knots/ranges");
        }
      }
      // PCHIP is range-preserving. Disjoint GLOBAL X hulls prove positive branch
      // widths for every Z, not merely at knots or a sampled approximation.
      if (
        operations.minX(p.crest) - p.crestWidth - p.minX < 2 ||
        operations.minX(p.shelf) - operations.maxX(p.crest) - p.shelfMinWidth <
          1 ||
        operations.minX(p.toe) - operations.maxX(p.shelf) < 2 ||
        p.maxX - operations.maxX(p.toe) < 1
      )
        operations.fail("curve separation");
      let length = 0;
      const segments: Segment[] = [];
      for (let i = 0; i < p.notch.length; i++) {
        const [x, z] = p.notch[i];
        if (x <= p.minX || x >= p.maxX || z <= p.minZ || z >= p.maxZ)
          operations.fail("notch bounds");
        if (i === 0) continue;
        const a = p.notch[i - 1],
          dx = x - a[0],
          dz = z - a[1],
          segmentLength = Math.hypot(dx, dz);
        if (segmentLength < 1) operations.fail("notch segment");
        segments.push({
          x: a[0],
          z: a[1],
          dx,
          dz,
          length: segmentLength,
          along: length,
        });
        length += segmentLength;
      }
      if (p.notchEndFade * 2 > length) operations.fail("notch fades");
      cache.set(p, {
        crest: operations.compileCurve(p.crest),
        shelf: operations.compileCurve(p.shelf),
        toe: operations.compileCurve(p.toe),
        segments,
        length,
      });
      return p;
    },
    sample(
      x: number,
      z: number,
      previousHeight: number,
      p: CompactHavenShoulder,
    ): number {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(z) ||
        !Number.isFinite(previousHeight)
      )
        operations.fail("sample input");
      let c = cache.get(p);
      if (!c) {
        // Admission may belong to another factory (CPU module or fresh worker).
        // Check descriptors before reading any caller fields or array methods.
        // Even outside the collar, only deeply immutable admitted descriptors
        // may be cached under the caller key.
        const admitted = operations.validate(p);
        if (
          !Object.isFrozen(p) ||
          ![p.crest, p.shelf, p.toe, p.notch].every(
            (a) => Object.isFrozen(a) && a.every(Object.isFrozen),
          )
        )
          operations.fail("unadmitted mutable descriptor");
        c = cache.get(admitted)!;
        cache.set(p, c);
      }
      if (x <= p.minX || x >= p.maxX || z <= p.minZ || z >= p.maxZ)
        return previousHeight;
      const weight =
        operations.smooth((x - p.minX) / p.westFade) *
        operations.smooth((p.maxX - x) / p.eastFade) *
        operations.smooth((z - p.minZ) / p.northFade) *
        operations.smooth((p.maxZ - z) / p.southFade);
      const cx = operations.curve(c.crest, z, 0),
        cy = operations.curve(c.crest, z, 2),
        sx = operations.curve(c.shelf, z, 0),
        sy = operations.curve(c.shelf, z, 2),
        tx = operations.curve(c.toe, z, 0),
        ty = operations.curve(c.toe, z, 2);
      const faceEnd = cx + Math.min(p.faceRun, sx - cx - p.shelfMinWidth);
      let target: number;
      if (x < cx - p.crestWidth)
        target = operations.mix(
          previousHeight,
          cy,
          operations.plane(
            (x - p.minX) / (cx - p.crestWidth - p.minX),
            p.faceChamfer,
          ),
        );
      else if (x < cx) target = cy;
      else if (x < faceEnd)
        target = operations.mix(
          cy,
          sy,
          operations.plane((x - cx) / (faceEnd - cx), p.faceChamfer),
        );
      else if (x < sx) target = sy;
      else if (x < tx)
        target = operations.mix(
          sy,
          ty,
          operations.plane((x - sx) / (tx - sx), p.faceChamfer),
        );
      else
        target = operations.mix(
          ty,
          previousHeight,
          operations.smooth((x - tx) / (p.maxX - tx)),
        );
      let cut = 0;
      for (const s of c.segments) {
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - s.x) * s.dx + (z - s.z) * s.dz) / (s.length * s.length),
          ),
        );
        const distance = Math.hypot(x - s.x - t * s.dx, z - s.z - t * s.dz);
        const along = s.along + t * s.length;
        // Each finite segment's projection, distance and end-faded cut are
        // continuous. Their maximum stays continuous even at foldbacks or
        // crossings; choosing one nearest segment's along value would not.
        cut = Math.max(
          cut,
          p.notchDepth *
            operations.smooth(1 - distance / p.notchWidth) *
            operations.smooth(along / p.notchEndFade) *
            operations.smooth((c.length - along) / p.notchEndFade),
        );
      }
      return operations.mix(
        previousHeight,
        Math.max(p.grade, target - cut),
        weight,
      );
    },
  };
  return { validate: operations.validate, sample: operations.sample };
}
