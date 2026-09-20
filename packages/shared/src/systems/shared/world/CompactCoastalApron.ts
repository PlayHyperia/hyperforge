/** Five fixed-order knots: bay coordinate q, reference height, height/q tangent. */
export type CompactCoastalApronKnot = readonly [number, number, number];
/** Optional world-space lowering-only inland head, separate from the bay mask. */
export type CompactCoastalHeadShoulder = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  featherX: number;
  featherZ: number;
  start: readonly [number, number, number];
  end: readonly [number, number, number];
  leftWidth: number;
  rightWidth: number;
  startFade: number;
  endFade: number;
  leftSlope: number;
  rightSlope: number;
  creaseWidth: number;
  blendHeight: number;
}>;
export type CompactCoastalApron = Readonly<{
  schemaVersion: 1;
  /** Raw-mask support. Its halo must fit the independently approved domain. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  featherX: number;
  featherZ: number;
  halo: number;
  floorHeight: number;
  referencePlateau: number;
  knots: readonly [
    CompactCoastalApronKnot,
    CompactCoastalApronKnot,
    CompactCoastalApronKnot,
    CompactCoastalApronKnot,
    CompactCoastalApronKnot,
  ];
  /** Optional curved western collar; the original full-strength edge is fixed. */
  westernShoulder?: Readonly<{
    maxWidth: number;
    startZ: number;
    endZ: number;
    featherZ: number;
  }>;
  /** Broad descending coastal catchment; unlike the collar this replaces the
   * plateau inside a curved, full-width off-road area. Reference heights
   * compensate the outer coast subject to its envelope; actual terrain relief
   * and canonical shoreline correction still apply. */
  lowland?: Readonly<{
    minZ: number;
    maxZ: number;
    startX: number;
    endX: number;
    descentLength: number;
    halfWidth: number;
    westHoldX: number;
    westMinX: number;
    westReleaseZ: number;
    westReleaseLength: number;
    eastMaxX: number;
    startBlend: number;
    endBlend: number;
    endHeight: number;
  }>;
  headShoulder?: CompactCoastalHeadShoulder;
}>;

type ApronSupport = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

/**
 * A specialized, bounded bay-factor replacement, not an absolute height layer.
 * All runtime dependencies live inside this factory for verbatim worker emission.
 * Admission owns/freeze-copies the recipe and compiles four scalar intervals;
 * admitted sampling allocates nothing and never changes the old factor outside
 * the compact C1 collar. Actual terrain relief/coast/shore correction still apply.
 */
export function createCompactCoastalApron() {
  type Interval = Readonly<{
    q: number;
    end: number;
    span: number;
    y: number;
    endY: number;
    linear: number;
    quadratic: number;
    cubic: number;
  }>;
  const cache = new WeakMap<CompactCoastalApron, readonly Interval[]>();
  const operations = {
    fail(field: string): never {
      throw new Error(`Invalid compact coastal apron: ${field}`);
    },
    record(
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
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== expected.length ||
        keys.some((key) => typeof key !== "string" || !expected.includes(key))
      )
        operations.fail("keys");
      for (const key of expected) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          operations.fail("own data fields");
      }
      return value as Record<string, unknown>;
    },
    finite(value: unknown): number {
      if (typeof value !== "number" || !Number.isFinite(value))
        return operations.fail("finite number");
      return value === 0 ? 0 : value;
    },
    smooth(value: number): number {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    },
    validate(input: unknown): CompactCoastalApron {
      const names = [
        "minX",
        "maxX",
        "minZ",
        "maxZ",
        "featherX",
        "featherZ",
        "halo",
        "floorHeight",
        "referencePlateau",
      ] as const;
      const hasShoulder =
        input !== null &&
        typeof input === "object" &&
        Object.prototype.hasOwnProperty.call(input, "westernShoulder");
      const hasLowland =
        input !== null &&
        typeof input === "object" &&
        Object.prototype.hasOwnProperty.call(input, "lowland");
      const hasHead =
        input !== null &&
        typeof input === "object" &&
        Object.prototype.hasOwnProperty.call(input, "headShoulder");
      const data = operations.record(input, [
        "schemaVersion",
        ...names,
        "knots",
        ...(hasShoulder ? ["westernShoulder"] : []),
        ...(hasLowland ? ["lowland"] : []),
        ...(hasHead ? ["headShoulder"] : []),
      ]);
      if (data.schemaVersion !== 1) operations.fail("schemaVersion");
      const numbers = Object.fromEntries(
        names.map((name) => [name, operations.finite(data[name])]),
      ) as Record<(typeof names)[number], number>;
      const raw = operations.record(
        data.knots,
        ["0", "1", "2", "3", "4", "length"],
        true,
      );
      if (raw.length !== 5) operations.fail("five knots");
      const knots = Object.freeze(
        [0, 1, 2, 3, 4].map((index) => {
          const knot = operations.record(
            raw[index],
            ["0", "1", "2", "length"],
            true,
          );
          if (knot.length !== 3) operations.fail("knot tuple");
          return Object.freeze([
            operations.finite(knot[0]),
            operations.finite(knot[1]),
            operations.finite(knot[2]),
          ]) as CompactCoastalApronKnot;
        }),
      ) as CompactCoastalApron["knots"];
      let westernShoulder: CompactCoastalApron["westernShoulder"];
      if (hasShoulder) {
        const s = operations.record(data.westernShoulder, [
          "maxWidth",
          "startZ",
          "endZ",
          "featherZ",
        ]);
        westernShoulder = Object.freeze({
          maxWidth: operations.finite(s.maxWidth),
          startZ: operations.finite(s.startZ),
          endZ: operations.finite(s.endZ),
          featherZ: operations.finite(s.featherZ),
        });
      }
      let lowland: CompactCoastalApron["lowland"];
      if (hasLowland) {
        const keys = [
          "minZ",
          "maxZ",
          "startX",
          "endX",
          "descentLength",
          "halfWidth",
          "westHoldX",
          "westMinX",
          "westReleaseZ",
          "westReleaseLength",
          "eastMaxX",
          "startBlend",
          "endBlend",
          "endHeight",
        ] as const;
        const rawLowland = operations.record(data.lowland, keys);
        lowland = Object.freeze(
          Object.fromEntries(
            keys.map((key) => [key, operations.finite(rawLowland[key])]),
          ) as NonNullable<CompactCoastalApron["lowland"]>,
        );
      }
      let headShoulder: CompactCoastalHeadShoulder | undefined;
      if (hasHead) {
        const keys = [
          "minX",
          "maxX",
          "minZ",
          "maxZ",
          "featherX",
          "featherZ",
          "leftWidth",
          "rightWidth",
          "startFade",
          "endFade",
          "leftSlope",
          "rightSlope",
          "creaseWidth",
          "blendHeight",
        ] as const;
        const rawHead = operations.record(data.headShoulder, [
          ...keys,
          "start",
          "end",
        ]);
        const points = ["start", "end"].map((key) => {
          const tuple = operations.record(
            rawHead[key],
            ["0", "1", "2", "length"],
            true,
          );
          if (tuple.length !== 3) operations.fail("head point tuple");
          return Object.freeze([
            operations.finite(tuple[0]),
            operations.finite(tuple[1]),
            operations.finite(tuple[2]),
          ]) as readonly [number, number, number];
        });
        headShoulder = Object.freeze({
          ...(Object.fromEntries(
            keys.map((key) => [key, operations.finite(rawHead[key])]),
          ) as Omit<CompactCoastalHeadShoulder, "start" | "end">),
          start: points[0],
          end: points[1],
        });
      }
      const p: CompactCoastalApron = Object.freeze({
        schemaVersion: 1,
        ...numbers,
        knots,
        ...(westernShoulder ? { westernShoulder } : {}),
        ...(lowland ? { lowland } : {}),
        ...(headShoulder ? { headShoulder } : {}),
      });
      const width = p.maxX - p.minX,
        depth = p.maxZ - p.minZ;
      const relief = p.referencePlateau - p.floorHeight;
      if (
        Math.max(
          Math.abs(p.minX),
          Math.abs(p.maxX),
          Math.abs(p.minZ),
          Math.abs(p.maxZ),
        ) > 10000 ||
        width < 16 ||
        width > 256 ||
        depth < 16 ||
        depth > 256 ||
        p.featherX < 2 ||
        p.featherX * 2 > width ||
        p.featherZ < 2 ||
        p.featherZ * 2 > depth ||
        p.halo <= 0 ||
        p.halo > 16 ||
        Math.abs(p.floorHeight) > 1000 ||
        Math.abs(p.referencePlateau) > 1000 ||
        relief < 1 ||
        relief > 256
      )
        operations.fail("shape ranges");
      if (
        westernShoulder &&
        (westernShoulder.maxWidth < p.featherX ||
          westernShoulder.maxWidth > 128 ||
          p.minX + p.featherX - westernShoulder.maxWidth < -10000 ||
          westernShoulder.startZ < p.minZ ||
          westernShoulder.endZ > p.maxZ ||
          westernShoulder.startZ >= westernShoulder.endZ ||
          westernShoulder.featherZ < 2 ||
          westernShoulder.featherZ * 2 >
            westernShoulder.endZ - westernShoulder.startZ)
      )
        operations.fail("western shoulder ranges");
      if (lowland) {
        const l = lowland;
        if (
          Math.max(
            Math.abs(l.minZ),
            Math.abs(l.maxZ),
            Math.abs(l.westMinX),
            Math.abs(l.eastMaxX),
          ) > 10000 ||
          l.maxZ - l.minZ < 40 ||
          l.maxZ - l.minZ > 256 ||
          l.eastMaxX - l.westMinX > 256 ||
          l.descentLength < 40 ||
          l.descentLength > 96 ||
          l.minZ + l.descentLength >= l.maxZ ||
          l.halfWidth < 9 ||
          l.halfWidth > 20 ||
          l.startX < l.endX ||
          l.startX - l.endX > 80 ||
          l.westMinX >= l.westHoldX ||
          l.westHoldX > l.startX - l.halfWidth - 2 ||
          l.westMinX > l.endX - l.halfWidth - 2 ||
          l.eastMaxX < l.startX + l.halfWidth + 2 ||
          l.westReleaseZ < l.minZ ||
          l.westReleaseZ + l.westReleaseLength > l.maxZ ||
          l.westReleaseLength < 16 ||
          l.westReleaseLength > 96 ||
          l.startBlend < 8 ||
          l.endBlend < 8 ||
          l.startBlend + l.endBlend > l.maxZ - l.minZ ||
          l.endHeight <= p.floorHeight ||
          l.endHeight >= p.referencePlateau ||
          l.endHeight +
            (l.endHeight - p.referencePlateau) *
              ((l.maxZ - l.minZ) / l.descentLength - 1) <
            p.floorHeight
        )
          operations.fail("lowland ranges");
        // Centerline and western edge share one progress, so the positive
        // endpoint collar widths above prove positive width between them.
      }
      if (headShoulder) {
        const h = headShoulder;
        const width = h.maxX - h.minX,
          depth = h.maxZ - h.minZ;
        const length = Math.hypot(h.end[0] - h.start[0], h.end[1] - h.start[1]);
        if (
          Math.max(
            Math.abs(h.minX),
            Math.abs(h.maxX),
            Math.abs(h.minZ),
            Math.abs(h.maxZ),
          ) > 10000 ||
          width < 16 ||
          width > 128 ||
          depth < 16 ||
          depth > 128 ||
          h.featherX < 2 ||
          2 * h.featherX > width ||
          h.featherZ < 2 ||
          2 * h.featherZ > depth ||
          length < 12 ||
          length > 96 ||
          [h.start, h.end].some(
            ([x, z]) => x < h.minX || x > h.maxX || z < h.minZ || z > h.maxZ,
          ) ||
          h.end[2] <= p.floorHeight ||
          h.end[2] > h.start[2] ||
          h.start[2] > p.referencePlateau ||
          h.leftWidth < 8 ||
          h.leftWidth > 40 ||
          h.rightWidth < 8 ||
          h.rightWidth > 40 ||
          h.startFade < 2 ||
          h.endFade < 2 ||
          h.startFade + h.endFade > length ||
          h.leftSlope < 0 ||
          h.leftSlope > 1 ||
          h.rightSlope < 0 ||
          h.rightSlope > 1 ||
          h.creaseWidth < 0.25 ||
          h.creaseWidth > 4 ||
          h.creaseWidth > Math.min(h.leftWidth, h.rightWidth) ||
          h.blendHeight < 0.05 ||
          h.blendHeight > 2
        )
          operations.fail("head shoulder ranges");
      }
      if (
        knots[0][0] >= 0 ||
        knots[4][0] <= 0 ||
        knots[0][1] !== p.floorHeight ||
        knots[4][1] !== p.referencePlateau ||
        knots[0][2] !== 0 ||
        knots[4][2] !== 0
      )
        operations.fail("section endpoints");
      for (const [q, height, tangent] of knots) {
        if (
          Math.abs(q) > 512 ||
          height < p.floorHeight ||
          height > p.referencePlateau ||
          tangent < 0 ||
          tangent > 4
        )
          operations.fail("knot ranges");
      }
      const intervals: Interval[] = [];
      for (let i = 0; i < 4; i++) {
        const a = knots[i],
          b = knots[i + 1];
        const span = b[0] - a[0],
          rise = b[1] - a[1];
        if (span < 1 || rise <= 0) operations.fail("ordered knots");
        const linear = span * a[2];
        const quadratic = 3 * rise - span * (2 * a[2] + b[2]);
        const cubic = -2 * rise + span * (a[2] + b[2]);
        // Exact minimum of the derivative quadratic on [0,1], not sampled
        // monotonicity or an automatic tangent limiter that changes authored data.
        if (cubic > 0) {
          const t = -quadratic / (3 * cubic);
          if (
            t > 0 &&
            t < 1 &&
            linear + t * (2 * quadratic + 3 * cubic * t) < 0
          )
            operations.fail("non-monotone Hermite interval");
        }
        intervals.push(
          Object.freeze({
            q: a[0],
            end: b[0],
            span,
            y: (a[1] - p.floorHeight) / relief,
            endY: (b[1] - p.floorHeight) / relief,
            linear: linear / relief,
            quadratic: quadratic / relief,
            cubic: cubic / relief,
          }),
        );
      }
      cache.set(p, Object.freeze(intervals));
      return p;
    },
    admitted(p: CompactCoastalApron): readonly Interval[] {
      const cached = cache.get(p);
      if (cached) return cached;
      // A fresh worker/factory can receive another factory's immutable recipe.
      // Validate descriptors before reading fields, and never cache mutable input.
      const copy = operations.validate(p);
      if (
        !Object.isFrozen(p) ||
        !Object.isFrozen(p.knots) ||
        !p.knots.every(Object.isFrozen) ||
        (p.westernShoulder !== undefined &&
          !Object.isFrozen(p.westernShoulder)) ||
        (p.lowland !== undefined && !Object.isFrozen(p.lowland)) ||
        (p.headShoulder !== undefined &&
          (!Object.isFrozen(p.headShoulder) ||
            !Object.isFrozen(p.headShoulder.start) ||
            !Object.isFrozen(p.headShoulder.end)))
      )
        operations.fail("unadmitted mutable recipe");
      const intervals = cache.get(copy)!;
      cache.set(p, intervals);
      return intervals;
    },
    /** Startup/validation only. The curved collar is contained by the second
     * rectangle, not by a widened box that would falsely cover the campus. */
    supportBounds(p: CompactCoastalApron): readonly ApronSupport[] {
      operations.admitted(p);
      const result: ApronSupport[] = [
        Object.freeze({
          minX: p.minX,
          maxX: p.maxX,
          minZ: p.minZ,
          maxZ: p.maxZ,
        }),
      ];
      if (p.westernShoulder)
        result.push(
          Object.freeze({
            minX: p.minX + p.featherX - p.westernShoulder.maxWidth,
            maxX: p.minX + p.featherX,
            minZ: p.westernShoulder.startZ,
            maxZ: p.westernShoulder.endZ,
          }),
        );
      if (p.lowland) {
        const l = p.lowland;
        result.push(
          Object.freeze({
            minX: l.westHoldX,
            maxX: l.eastMaxX,
            minZ: l.minZ,
            maxZ: l.westReleaseZ,
          }),
        );
        result.push(
          Object.freeze({
            minX: l.westMinX,
            maxX: l.eastMaxX,
            minZ: l.westReleaseZ,
            maxZ: l.maxZ,
          }),
        );
      }
      if (p.headShoulder) {
        const h = p.headShoulder;
        result.push(
          Object.freeze({
            minX: h.minX,
            maxX: h.maxX,
            minZ: h.minZ,
            maxZ: h.maxZ,
          }),
        );
      }
      return Object.freeze(result);
    },
    validateSupport(
      p: CompactCoastalApron,
      support: Readonly<{
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
      }>,
      slopeSampleDistance: number,
    ): void {
      operations.admitted(p);
      const r = operations.record(support, ["minX", "maxX", "minZ", "maxZ"]);
      const minX = operations.finite(r.minX),
        maxX = operations.finite(r.maxX);
      const minZ = operations.finite(r.minZ),
        maxZ = operations.finite(r.maxZ);
      const stencil = operations.finite(slopeSampleDistance);
      if (
        minX >= maxX ||
        minZ >= maxZ ||
        stencil < 0 ||
        stencil > p.halo ||
        operations
          .supportBounds(p)
          .some(
            (b) =>
              b.minX - p.halo < minX ||
              b.maxX + p.halo > maxX ||
              b.minZ - p.halo < minZ ||
              b.maxZ + p.halo > maxZ,
          )
      )
        operations.fail("canonical support/halo");
    },
    evaluate(q: number, intervals: readonly Interval[]): number {
      if (q <= intervals[0].q) return 0;
      if (q >= intervals[3].end) return 1;
      let i = 0;
      while (q > intervals[i].end) i++;
      const s = intervals[i],
        t = (q - s.q) / s.span;
      const value = s.y + t * (s.linear + t * (s.quadratic + t * s.cubic));
      // Admission proves monotonicity; this only confines endpoint roundoff.
      return Math.max(s.y, Math.min(s.endY, value));
    },
    section(q: number, p: CompactCoastalApron): number {
      operations.finite(q);
      return operations.evaluate(q, operations.admitted(p));
    },
    sampleHead(
      x: number,
      z: number,
      previousHeight: number,
      p?: CompactCoastalApron,
    ): number {
      if (p === undefined) return previousHeight;
      operations.admitted(p);
      const h = p.headShoulder;
      if (!h) return previousHeight;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(z) ||
        !Number.isFinite(previousHeight)
      )
        operations.fail("head sample input");
      if (
        x <= h.minX ||
        x >= h.maxX ||
        z <= h.minZ ||
        z >= h.maxZ ||
        previousHeight <= h.end[2]
      )
        return previousHeight;
      const dx = h.end[0] - h.start[0],
        dz = h.end[1] - h.start[1];
      const length = Math.hypot(dx, dz),
        ux = dx / length,
        uz = dz / length;
      const rx = x - h.start[0],
        rz = z - h.start[1];
      const along = rx * ux + rz * uz,
        cross = -rx * uz + rz * ux;
      const width = cross < 0 ? h.leftWidth : h.rightWidth;
      const crossAbs = Math.abs(cross);
      if (along <= 0 || along >= length || crossAbs >= width)
        return previousHeight;
      const roundedAbs =
        crossAbs < h.creaseWidth
          ? (crossAbs * crossAbs) / (2 * h.creaseWidth)
          : crossAbs - h.creaseWidth / 2;
      const target =
        h.start[2] +
        (h.end[2] - h.start[2]) * operations.smooth(along / length) +
        (cross < 0 ? h.leftSlope : h.rightSlope) * roundedAbs;
      const delta = previousHeight - target;
      if (delta <= 0) return previousHeight;
      const weight =
        operations.smooth((x - h.minX) / h.featherX) *
        operations.smooth((h.maxX - x) / h.featherX) *
        operations.smooth((z - h.minZ) / h.featherZ) *
        operations.smooth((h.maxZ - z) / h.featherZ) *
        operations.smooth(along / h.startFade) *
        operations.smooth((length - along) / h.endFade) *
        operations.smooth(1 - crossAbs / width);
      // Equivalent to delta²/(delta+blendHeight), without an overflowing square.
      // The positive soft cut is C1 at zero and never reaches below its target.
      return Math.max(
        target,
        previousHeight - weight * delta * (delta / (delta + h.blendHeight)),
      );
    },
    blendBay(
      x: number,
      z: number,
      q: number,
      previous: number,
      p?: CompactCoastalApron,
      coastMask = 1,
    ): number {
      // The absent recipe performs no arithmetic/validation on historical input.
      if (p === undefined) return previous;
      const intervals = operations.admitted(p);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(z) ||
        !Number.isFinite(q) ||
        !Number.isFinite(previous) ||
        previous < 0 ||
        previous > 1
      )
        operations.fail("sample input");
      const shoulder = p.westernShoulder;
      // Keep the literal historical evaluation when absent/outside the added
      // shoulder. Only its western collar changes; the interior stays exact.
      let westernEdge = p.minX,
        westernWidth = p.featherX;
      if (
        shoulder &&
        z > shoulder.startZ &&
        z < shoulder.endZ &&
        x < p.minX + p.featherX
      ) {
        westernWidth +=
          (shoulder.maxWidth - p.featherX) *
          operations.smooth((z - shoulder.startZ) / shoulder.featherZ) *
          operations.smooth((shoulder.endZ - z) / shoulder.featherZ);
        westernEdge = p.minX + p.featherX - westernWidth;
      }
      let result = previous;
      // Lowland is a replacement composition, not another layer over the
      // legacy apron/collar scarp. Absence retains that historical arithmetic.
      if (
        !p.lowland &&
        x > westernEdge &&
        x < p.maxX &&
        z > p.minZ &&
        z < p.maxZ
      ) {
        const weight =
          operations.smooth((x - westernEdge) / westernWidth) *
          operations.smooth((p.maxX - x) / p.featherX) *
          operations.smooth((z - p.minZ) / p.featherZ) *
          operations.smooth((p.maxZ - z) / p.featherZ);
        result =
          previous + weight * (operations.evaluate(q, intervals) - previous);
      }
      const l = p.lowland;
      if (!l || z <= l.minZ || z >= l.maxZ || x >= l.eastMaxX) return result;
      if (!Number.isFinite(coastMask) || coastMask <= 0 || coastMask > 1)
        operations.fail("lowland outer coast");
      const progress = Math.max(0, Math.min(1, (z - l.minZ) / l.descentLength));
      const bend = operations.smooth(
        (z - l.westReleaseZ) / l.westReleaseLength,
      );
      const centerX = l.startX + (l.endX - l.startX) * bend;
      const west = l.westHoldX + (l.westMinX - l.westHoldX) * bend;
      if (x <= west) return result;
      const westInner = centerX - l.halfWidth;
      const weight =
        operations.smooth((x - west) / (westInner - west)) *
        operations.smooth(
          (l.eastMaxX - x) / (l.eastMaxX - centerX - l.halfWidth),
        ) *
        operations.smooth((z - l.minZ) / l.startBlend) *
        operations.smooth((l.maxZ - z) / l.endBlend);
      // Cubic descent starts horizontal and meets its continued downstream
      // tangent without a terrace. The existing coast still owns the seabed.
      const fall = l.endHeight - p.referencePlateau;
      const referenceHeight =
        p.referencePlateau +
        fall *
          (progress * progress * (2 - progress) +
            Math.max(0, (z - l.minZ) / l.descentLength - 1));
      // Author the broad ground height, not two multiplied downhill ramps.
      // Compensating the outer coast avoids an extra grade across the lowland;
      // the C1 cap retains the original outer land envelope (never factor >1).
      const desired = Math.max(
        0,
        (referenceHeight - p.floorHeight) /
          ((p.referencePlateau - p.floorHeight) * coastMask),
      );
      const capProgress = (desired - 0.9) / 0.2;
      const target =
        desired <= 0.9
          ? desired
          : desired >= 1.1
            ? 1
            : 0.9 + 0.2 * capProgress - 0.1 * capProgress * capProgress;
      return result + weight * (target - result);
    },
  };
  return {
    validate: operations.validate,
    validateSupport: operations.validateSupport,
    supportBounds: operations.supportBounds,
    section: operations.section,
    sampleHead: operations.sampleHead,
    blendBay: operations.blendBay,
  };
}
