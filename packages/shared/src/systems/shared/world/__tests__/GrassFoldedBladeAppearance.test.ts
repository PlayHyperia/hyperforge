import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  createClumpGeometry,
  FINE_GRASS_BASAL_SHEATH_SHAPE,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
} from "../GrassVisualManager";

// Real source geometry only. These checks do not simulate a renderer or approve
// visible density, grounding, native GPU cost, lighting, or artistic quality.
const NEAR_BLADES = 24;
const PLAIN_STRIDE = 7;
const FOLDED_STRIDE = 9;
const FOLDED_TRIANGLES = 9;
const WIDTH_STATIONS = [1, 1.2, 0.72] as const;
const VERTEX_PARAMETERS = [
  [-1, 0],
  [1, 0],
  [-1, 1 / 3],
  [1, 1 / 3],
  [-1, 2 / 3],
  [1, 2 / 3],
  [0, 1],
  [0, 1 / 3],
  [0, 2 / 3],
] as const;

// Archived pre-trial generator hashes, position/normal/UV/index in that order.
// Never replace these with candidate output to make this regression pass.
const LEGACY_HASHES = [
  "30d43cae657ad1a55190ed6e23dda8cc7973ee4bb684a248e9d39ee851f5a109",
  "06e6a222140aa84141061eb5775b6dc46a84a8a739b69d8ee00450de8b695b2d",
  "b6d82f6b4b98e0d3a5a40813c6a5f8bac7ff94559df4e77f058a1aba4ae4a26c",
] as const;

// Actual typed-array byte hashes from native142/grass-geometry-lod0.json,
// captured before the sheath generator study; not candidate-derived hashes.
// Its actual submitted index is Uint32Array (648 indices / 2592 bytes),
// whereas the source factory deliberately retains its smaller Uint16Array.
const FOLDED_NATIVE142_HASHES = {
  position: "3dad967dc9f158825106449aa2ec0a35accfdc09d7492ddd4e375072dd258386",
  normal: "4d44fc0c9c1acb355adcb7ce42fca9379337899aedae25fedc0f2e9ca926822f",
  uv: "8bfcb407c522d82efbcb7d771f0fe7347bbabe3eeaffc3ac77e36a323b5319a4",
  index: "62a209e1d96cd8f5b491e854a19c27201bc13851e6d07d6dffaf587a812fae2f",
} as const;

function geometryDigest(geometry: THREE.BufferGeometry): string {
  const digest = createHash("sha256");
  for (const attribute of [
    geometry.getAttribute("position"),
    geometry.getAttribute("normal"),
    geometry.getAttribute("uv"),
    geometry.index!,
  ]) {
    const values = attribute.array;
    digest.update(
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    );
  }
  return digest.digest("hex");
}

function vertex(geometry: THREE.BufferGeometry, index: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute("position"),
    index,
  );
}

function normal(geometry: THREE.BufferGeometry, index: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute("normal"),
    index,
  );
}

function expectVectorClose(
  actual: THREE.Vector3,
  expected: THREE.Vector3,
  tolerance = 2e-6,
): void {
  expect(actual.distanceTo(expected)).toBeLessThan(tolerance);
}

function bytes(geometry: THREE.BufferGeometry): number {
  return (
    Object.values(geometry.attributes).reduce(
      (sum, attribute) => sum + attribute.array.byteLength,
      0,
    ) + geometry.index!.array.byteLength
  );
}

/** Independently recover the original blade's parameters from its unchanged
 * root edges and tip; do not import the candidate's width/normal helpers.
 * Float32 source endpoints limit the oracle's accuracy, hence explicit tolerances.
 */
class BladeSurface {
  readonly root: THREE.Vector3;
  readonly transverse: THREE.Vector3;
  readonly ridgeDirection: THREE.Vector3;
  readonly arc: THREE.Vector3;
  readonly baseHalfWidth: number;
  readonly height: number;

  constructor(
    plain: THREE.BufferGeometry,
    blade: number,
    private readonly basalSheath = false,
  ) {
    const left = vertex(plain, blade * PLAIN_STRIDE);
    const right = vertex(plain, blade * PLAIN_STRIDE + 1);
    const tip = vertex(plain, blade * PLAIN_STRIDE + 6);
    this.root = left.clone().add(right).multiplyScalar(0.5);
    this.baseHalfWidth = left.distanceTo(right) * 0.5;
    this.transverse = right.clone().sub(left).normalize();
    this.ridgeDirection = new THREE.Vector3(
      -this.transverse.z,
      0,
      this.transverse.x,
    );
    this.height = tip.y / 0.95;
    this.arc = tip.clone().sub(this.root).setY(0);
  }

  private width(t: number): number {
    const previous =
      this.baseHalfWidth * (1 + 2.06 * t - 5.04 * t * t + 1.98 * t ** 3);
    if (!this.basalSheath) return previous;
    const x = Math.max(0, Math.min(1, t / 0.2));
    return previous * (0.25 + 0.75 * x * x * (3 - 2 * x));
  }

  private widthDerivative(t: number): number {
    const previousDerivative =
      this.baseHalfWidth * (2.06 - 10.08 * t + 5.94 * t * t);
    if (!this.basalSheath) return previousDerivative;
    const x = Math.max(0, Math.min(1, t / 0.2));
    const factor = 0.25 + 0.75 * x * x * (3 - 2 * x);
    const derivative = t > 0 && t < 0.2 ? (0.75 * 6 * x * (1 - x)) / 0.2 : 0;
    const previous =
      this.baseHalfWidth * (1 + 2.06 * t - 5.04 * t * t + 1.98 * t ** 3);
    return previousDerivative * factor + previous * derivative;
  }

  point(s: number, t: number): THREE.Vector3 {
    const halfWidth = this.width(t);
    const ridge = halfWidth * 0.36 * 16 * t * t * (1 - t) ** 2;
    return this.root
      .clone()
      .addScaledVector(this.arc, 0.7 * t + 0.3 * t * t)
      .addScaledVector(this.transverse, s * halfWidth)
      .addScaledVector(this.ridgeDirection, ridge * (1 - s * s))
      .setY(this.height * (1.52 * t - 0.57 * t * t));
  }

  tangents(s: number, t: number): [THREE.Vector3, THREE.Vector3] {
    const halfWidth = this.width(t);
    const halfWidthDerivative = this.widthDerivative(t);
    const window = 16 * t * t * (1 - t) ** 2;
    const windowDerivative = 32 * t * (1 - t) * (1 - 2 * t);
    const ridge = halfWidth * 0.36 * window;
    const ridgeDerivative =
      0.36 * (halfWidthDerivative * window + halfWidth * windowDerivative);
    const transverse = this.transverse
      .clone()
      .multiplyScalar(halfWidth)
      .addScaledVector(this.ridgeDirection, -2 * s * ridge);
    const longitudinal = this.arc
      .clone()
      .multiplyScalar(0.7 + 0.6 * t)
      .setY(this.height * (1.52 - 1.14 * t))
      .addScaledVector(this.transverse, s * halfWidthDerivative)
      .addScaledVector(this.ridgeDirection, ridgeDerivative * (1 - s * s));
    return [transverse, longitudinal];
  }
}

function geometryPair(blades = NEAR_BLADES) {
  const plain = createClumpGeometry(blades, 3, FINE_MEADOW_APPEARANCE);
  const folded = createClumpGeometry(
    blades,
    3,
    FINE_GRASS_FOLDED_BLADE_SHAPE,
    "folded-lancet-v1",
  );
  return {
    plain,
    folded,
    dispose: () => [plain, folded].forEach((g) => g.dispose()),
  };
}

describe("physical folded lancet source geometry (CPU only)", () => {
  it("rejects unsupported segment counts and uncurved or unknown cross-sections", () => {
    for (const segments of [1, 2, 4])
      expect(() =>
        createClumpGeometry(
          24,
          segments,
          FINE_GRASS_FOLDED_BLADE_SHAPE,
          "folded-lancet-v1",
        ),
      ).toThrow("Folded grass requires");
    expect(() =>
      createClumpGeometry(24, 3, GRASS_CONFIG, "folded-lancet-v1"),
    ).toThrow("Folded grass requires");
    expect(() =>
      createClumpGeometry(
        24,
        3,
        FINE_GRASS_FOLDED_BLADE_SHAPE,
        "unknown" as never,
      ),
    ).toThrow("Folded grass requires");
  });

  it("exposes the explicit shape and budgets exactly two extra vertices/four triangles per near blade", () => {
    const pair = geometryPair();
    try {
      expect(FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_WIDTH_POLYNOMIAL).toEqual([
        1, 2.06, -5.04, 1.98,
      ]);
      expect(FINE_GRASS_FOLDED_BLADE_SHAPE.BLADE_RIDGE_TANGENT).toBe(0.36);
      expect(pair.plain.getAttribute("position").count).toBe(168);
      expect(pair.plain.index!.count).toBe(360);
      expect(pair.folded.getAttribute("position").count).toBe(216);
      expect(pair.folded.getAttribute("normal").count).toBe(216);
      expect(pair.folded.getAttribute("uv").count).toBe(216);
      expect(pair.folded.index!.count).toBe(648);
      expect(pair.folded.index!.array).toBeInstanceOf(Uint16Array);
      expect(Object.keys(pair.folded.attributes).sort()).toEqual([
        "normal",
        "position",
        "uv",
      ]);
      expect(bytes(pair.plain)).toBe(6096);
      expect(bytes(pair.folded)).toBe(8208);
      expect(bytes(pair.folded) - bytes(pair.plain)).toBe(2112);
    } finally {
      pair.dispose();
    }
  });

  it("preserves every original root edge, tip, height and UV while appending only the two ridge stations", () => {
    const pair = geometryPair();
    try {
      for (let blade = 0; blade < NEAR_BLADES; blade++) {
        for (const endpoint of [0, 1, 6]) {
          expect(
            vertex(pair.folded, blade * FOLDED_STRIDE + endpoint).toArray(),
          ).toEqual(
            vertex(pair.plain, blade * PLAIN_STRIDE + endpoint).toArray(),
          );
          expect(
            normal(pair.folded, blade * FOLDED_STRIDE + endpoint).toArray(),
          ).toEqual(
            normal(pair.plain, blade * PLAIN_STRIDE + endpoint).toArray(),
          );
        }
        for (const [local, [s, t]] of VERTEX_PARAMETERS.entries()) {
          const uv = pair.folded.getAttribute("uv");
          const index = blade * FOLDED_STRIDE + local;
          expect(uv.getX(index)).toBe((s + 1) * 0.5);
          expect(uv.getY(index)).toBe(Math.fround(t));
          const sameHeight = local < 7 ? local : local === 7 ? 2 : 4;
          expect(vertex(pair.folded, index).y).toBe(
            vertex(pair.plain, blade * PLAIN_STRIDE + sameHeight).y,
          );
        }
      }
    } finally {
      pair.dispose();
    }
  });

  it("matches the independent smooth width, centerline and horizontal parabolic ridge surface", () => {
    const pair = geometryPair();
    try {
      for (let blade = 0; blade < NEAR_BLADES; blade++) {
        const surface = new BladeSurface(pair.plain, blade);
        for (const [local, [s, t]] of VERTEX_PARAMETERS.entries()) {
          expectVectorClose(
            vertex(pair.folded, blade * FOLDED_STRIDE + local),
            surface.point(s, t),
          );
        }
        for (let station = 0; station < 3; station++) {
          const left = vertex(pair.folded, blade * FOLDED_STRIDE + station * 2);
          const right = vertex(
            pair.folded,
            blade * FOLDED_STRIDE + station * 2 + 1,
          );
          expect(
            left.distanceTo(right) / (2 * surface.baseHalfWidth),
          ).toBeCloseTo(WIDTH_STATIONS[station], 5);
          if (station === 0) continue;
          const center = vertex(
            pair.folded,
            blade * FOLDED_STRIDE + station + 6,
          );
          const ridge = center.sub(left.add(right).multiplyScalar(0.5));
          const t = station / 3;
          const expectedRidge =
            surface.baseHalfWidth *
            WIDTH_STATIONS[station] *
            0.36 *
            16 *
            t *
            t *
            (1 - t) ** 2;
          expect(ridge.y).toBe(0);
          expect(ridge.dot(surface.transverse)).toBeCloseTo(0, 6);
          expect(ridge.dot(surface.ridgeDirection)).toBeCloseTo(
            expectedRidge,
            6,
          );
          expect(ridge.length()).toBeGreaterThan(0);
        }
      }
    } finally {
      pair.dispose();
    }
  });

  it("uses finite unit analytic normals orthogonal to both independent surface tangents", () => {
    const pair = geometryPair();
    try {
      for (let blade = 0; blade < NEAR_BLADES; blade++) {
        const surface = new BladeSurface(pair.plain, blade);
        for (const [local, [s, t]] of VERTEX_PARAMETERS.entries()) {
          const actual = normal(pair.folded, blade * FOLDED_STRIDE + local);
          expect(actual.toArray().every(Number.isFinite)).toBe(true);
          expect(actual.length()).toBeCloseTo(1, 6);
          // The single zero-width tip uses the unchanged centerline limit.
          if (t === 1) continue;
          const [ps, pt] = surface.tangents(s, t);
          const expected = ps.clone().cross(pt).normalize();
          expectVectorClose(actual, expected, 5e-6);
          expect(Math.abs(actual.dot(ps.clone().normalize()))).toBeLessThan(
            5e-6,
          );
          expect(Math.abs(actual.dot(pt.clone().normalize()))).toBeLessThan(
            5e-6,
          );
          // Independent numerical differentiation detects a wrong analytic
          // derivative even if a copied cross-product formula looks plausible.
          const epsilon = 1e-4;
          const numericalS = surface
            .point(s + epsilon, t)
            .sub(surface.point(s - epsilon, t))
            .normalize();
          const numericalT = surface
            .point(s, t + epsilon)
            .sub(surface.point(s, t - epsilon))
            .normalize();
          expect(Math.abs(actual.dot(numericalS))).toBeLessThan(5e-6);
          expect(Math.abs(actual.dot(numericalT))).toBeLessThan(5e-6);
        }
        // The physical sections really differ; a flat copied strip normal must
        // not pass just because normals have unit length.
        for (const station of [1, 2]) {
          const left = normal(pair.folded, blade * FOLDED_STRIDE + station * 2);
          const right = normal(
            pair.folded,
            blade * FOLDED_STRIDE + station * 2 + 1,
          );
          expect(left.dot(right)).toBeLessThan(0.99);
        }
      }
    } finally {
      pair.dispose();
    }
  });

  it("has finite, nondegenerate, consistently wound triangles confined to each blade", () => {
    const pair = geometryPair();
    try {
      const positions = pair.folded.getAttribute("position");
      const indices = pair.folded.index!;
      expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
      let area = 0;
      for (let blade = 0; blade < NEAR_BLADES; blade++) {
        const used = new Set<number>();
        for (let triangle = 0; triangle < FOLDED_TRIANGLES; triangle++) {
          const start = (blade * FOLDED_TRIANGLES + triangle) * 3;
          const abc = [0, 1, 2].map((offset) => indices.getX(start + offset));
          for (const index of abc) {
            expect(Number.isInteger(index)).toBe(true);
            expect(index).toBeGreaterThanOrEqual(blade * FOLDED_STRIDE);
            expect(index).toBeLessThan((blade + 1) * FOLDED_STRIDE);
            used.add(index - blade * FOLDED_STRIDE);
          }
          const [a, b, c] = abc.map((index) => vertex(pair.folded, index));
          const cross = b.sub(a).cross(c.sub(a));
          expect(cross.length()).toBeGreaterThan(1e-8);
          const averageNormal = abc.reduce(
            (sum, index) => sum.add(normal(pair.folded, index)),
            new THREE.Vector3(),
          );
          expect(cross.dot(averageNormal)).toBeGreaterThan(0);
          area += cross.length() * 0.5;
        }
        expect([...used].sort((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
      }
      expect(Number.isFinite(area)).toBe(true);
      expect(area).toBeGreaterThan(0);
      pair.folded.computeBoundingBox();
      pair.plain.computeBoundingBox();
      expect(pair.folded.boundingBox!.min.y).toBe(0);
      expect(pair.folded.boundingBox!.max.y).toBe(
        pair.plain.boundingBox!.max.y,
      );
      const dimensions = pair.folded.boundingBox!.getSize(new THREE.Vector3());
      expect(
        dimensions
          .toArray()
          .every((value) => Number.isFinite(value) && value > 0),
      ).toBe(true);
      console.info(
        "Folded lancet source geometry only; not visual/performance approval",
        {
          vertices: positions.count,
          triangles: indices.count / 3,
          bytes: bytes(pair.folded),
          area,
          dimensions: dimensions.toArray(),
        },
      );
    } finally {
      pair.dispose();
    }
  });

  it("keeps progressive blade prefixes identical without extra random draws", () => {
    const full = geometryPair();
    const prefix = geometryPair(12);
    try {
      for (const key of ["position", "normal", "uv"]) {
        const a = full.folded.getAttribute(key).array;
        const b = prefix.folded.getAttribute(key).array;
        expect(a.slice(0, b.length)).toEqual(b);
      }
      expect(
        full.folded.index!.array.slice(0, prefix.folded.index!.count),
      ).toEqual(prefix.folded.index!.array);
      for (let blade = 0; blade < 12; blade++) {
        for (const endpoint of [0, 1, 6]) {
          expect(
            vertex(prefix.folded, blade * FOLDED_STRIDE + endpoint).toArray(),
          ).toEqual(
            vertex(full.plain, blade * PLAIN_STRIDE + endpoint).toArray(),
          );
        }
      }
    } finally {
      full.dispose();
      prefix.dispose();
    }
  });

  it("preserves archived ordinary bytes and leaves explicit plain/mid/far calls unchanged after the trial", () => {
    const ordinary = GRASS_CONFIG.LOD_TIERS.map((tier) =>
      createClumpGeometry(tier.bladesPerClump, tier.bladeSegments),
    );
    const before = GRASS_CONFIG.LOD_TIERS.map((tier) =>
      createClumpGeometry(
        tier.bladesPerClump,
        tier.bladeSegments,
        FINE_MEADOW_APPEARANCE,
      ),
    );
    const trial = geometryPair();
    const after = GRASS_CONFIG.LOD_TIERS.map((tier) =>
      createClumpGeometry(
        tier.bladesPerClump,
        tier.bladeSegments,
        FINE_MEADOW_APPEARANCE,
      ),
    );
    try {
      expect(ordinary.map(geometryDigest)).toEqual(LEGACY_HASHES);
      for (let lod = 0; lod < before.length; lod++) {
        expect(geometryDigest(after[lod])).toBe(geometryDigest(before[lod]));
        const plainShape = createClumpGeometry(
          GRASS_CONFIG.LOD_TIERS[lod].bladesPerClump,
          GRASS_CONFIG.LOD_TIERS[lod].bladeSegments,
          FINE_GRASS_FOLDED_BLADE_SHAPE,
        );
        try {
          expect(geometryDigest(plainShape)).toBe(geometryDigest(before[lod]));
        } finally {
          plainShape.dispose();
        }
      }
    } finally {
      ordinary.forEach((geometry) => geometry.dispose());
      before.forEach((geometry) => geometry.dispose());
      after.forEach((geometry) => geometry.dispose());
      trial.dispose();
    }
  });
});

describe("explicit five/six-section basal sheath generator study (not selected in-world)", () => {
  function parameters(segments: number): [number, number][] {
    const rows: [number, number][] = [];
    for (let row = 0; row < segments; row++)
      rows.push([-1, row / segments], [1, row / segments]);
    rows.push([0, 1]);
    for (let row = 1; row < segments; row++) rows.push([0, row / segments]);
    return rows;
  }

  function sheath(segments: number, blades = NEAR_BLADES) {
    return createClumpGeometry(
      blades,
      segments,
      FINE_GRASS_FOLDED_BLADE_SHAPE,
      "folded-sheath-v1",
    );
  }

  it("requires explicit five/six-section curved study admission and a frozen sheath policy", () => {
    expect(FINE_GRASS_BASAL_SHEATH_SHAPE).toEqual({
      id: "basal-sheath-v1",
      rootWidthFactor: 0.25,
      fullWidthHeight: 0.2,
    });
    expect(Object.isFrozen(FINE_GRASS_BASAL_SHEATH_SHAPE)).toBe(true);
    for (const segments of [0, 1, 2, 3, 4, 7])
      expect(() => sheath(segments)).toThrow("Folded grass requires");
    for (const segments of [5, 6]) {
      expect(() =>
        createClumpGeometry(24, segments, GRASS_CONFIG, "folded-sheath-v1"),
      ).toThrow("Folded grass requires");
      expect(() =>
        createClumpGeometry(
          24,
          segments,
          FINE_GRASS_FOLDED_BLADE_SHAPE,
          "folded-lancet-v1",
        ),
      ).toThrow("Folded grass requires");
    }
  });

  it.each([5, 6])(
    "accounts for all geometry cost at %s sections without reducing blade population",
    (segments) => {
      const candidate = sheath(segments);
      const baseline = geometryPair();
      try {
        expect(candidate.getAttribute("position").count).toBe(
          NEAR_BLADES * 3 * segments,
        );
        expect(candidate.getAttribute("normal").count).toBe(
          NEAR_BLADES * 3 * segments,
        );
        expect(candidate.getAttribute("uv").count).toBe(
          NEAR_BLADES * 3 * segments,
        );
        expect(candidate.index!.count).toBe(
          NEAR_BLADES * (4 * segments - 3) * 3,
        );
        expect(candidate.index!.array).toBeInstanceOf(Uint16Array);
        expect(Object.keys(candidate.attributes).sort()).toEqual([
          "normal",
          "position",
          "uv",
        ]);
        expect(bytes(candidate)).toBe(segments === 5 ? 13968 : 16848);
        expect(bytes(candidate) - bytes(baseline.folded)).toBe(
          segments === 5 ? 5760 : 8640,
        );
        expect(
          candidate.getAttribute("position").count /
            baseline.folded.getAttribute("position").count,
        ).toBe(segments / 3);
        expect(candidate.index!.count / baseline.folded.index!.count).toBe(
          (4 * segments - 3) / 9,
        );
        // Buffer cost is measured, not a prediction of native GPU frame time.
        expect(candidate.groups).toEqual([]);
        expect(candidate.drawRange).toEqual({ start: 0, count: Infinity });
      } finally {
        candidate.dispose();
        baseline.dispose();
      }
    },
  );

  it.each([5, 6])(
    "matches an independent smooth sheath surface and normals at every actual %s-section vertex",
    (segments) => {
      const candidate = sheath(segments);
      const baseline = geometryPair();
      const stride = 3 * segments;
      try {
        for (let blade = 0; blade < NEAR_BLADES; blade++) {
          const surface = new BladeSurface(baseline.plain, blade, true);
          for (const [local, [s, t]] of parameters(segments).entries()) {
            const index = blade * stride + local;
            const actualNormal = normal(candidate, index);
            expect(candidate.getAttribute("uv").getX(index)).toBe((s + 1) / 2);
            expect(candidate.getAttribute("uv").getY(index)).toBe(
              Math.fround(t),
            );
            expectVectorClose(vertex(candidate, index), surface.point(s, t));
            expect(actualNormal.toArray().every(Number.isFinite)).toBe(true);
            expect(actualNormal.length()).toBeCloseTo(1, 6);
            if (t === 1) {
              expect(vertex(candidate, index).toArray()).toEqual(
                vertex(baseline.plain, blade * PLAIN_STRIDE + 6).toArray(),
              );
              expect(actualNormal.toArray()).toEqual(
                normal(baseline.plain, blade * PLAIN_STRIDE + 6).toArray(),
              );
              continue;
            }
            const [ps, pt] = surface.tangents(s, t);
            expectVectorClose(
              actualNormal,
              ps.clone().cross(pt).normalize(),
              5e-6,
            );
            expect(
              Math.abs(actualNormal.dot(ps.clone().normalize())),
            ).toBeLessThan(5e-6);
            expect(
              Math.abs(actualNormal.dot(pt.clone().normalize())),
            ).toBeLessThan(5e-6);
            const epsilon = 1e-5;
            const numericalS = surface
              .point(s + epsilon, t)
              .sub(surface.point(s - epsilon, t))
              .normalize();
            const numericalT = surface
              .point(s, t + epsilon)
              .sub(surface.point(s, t - epsilon))
              .normalize();
            expect(Math.abs(actualNormal.dot(numericalS))).toBeLessThan(5e-6);
            // At t=.2 the piecewise smoothstep is C1, not C2; central finite
            // differences straddle its second-derivative discontinuity.
            expect(Math.abs(actualNormal.dot(numericalT))).toBeLessThan(2e-5);
          }
          const left = vertex(candidate, blade * stride);
          const right = vertex(candidate, blade * stride + 1);
          const oldLeft = vertex(baseline.plain, blade * PLAIN_STRIDE);
          const oldRight = vertex(baseline.plain, blade * PLAIN_STRIDE + 1);
          expectVectorClose(
            left.clone().add(right).multiplyScalar(0.5),
            surface.root,
            2e-7,
          );
          expect(left.y).toBe(0);
          expect(right.y).toBe(0);
          expect(
            left.distanceTo(right) / oldLeft.distanceTo(oldRight),
          ).toBeCloseTo(0.25, 5);
          expect(left.distanceTo(oldLeft)).toBeGreaterThan(0.001);
          expect(right.distanceTo(oldRight)).toBeGreaterThan(0.001);
          // Narrow root footprint does NOT preserve old root edge coordinates.
          for (const side of [0, 1])
            expect(normal(candidate, blade * stride + side).toArray()).toEqual(
              normal(baseline.plain, blade * PLAIN_STRIDE + side).toArray(),
            );
          for (let row = 1; row < segments; row++) {
            const t = row / segments;
            const center = vertex(
              candidate,
              blade * stride + 2 * segments + row,
            );
            const edgeMidpoint = vertex(candidate, blade * stride + row * 2)
              .add(vertex(candidate, blade * stride + row * 2 + 1))
              .multiplyScalar(0.5);
            expect(center.y).toBe(edgeMidpoint.y);
            expect(
              center.clone().sub(edgeMidpoint).dot(surface.ridgeDirection),
            ).toBeGreaterThan(0);
            if (t >= 0.2) {
              const widthRatio =
                vertex(candidate, blade * stride + row * 2).distanceTo(
                  vertex(candidate, blade * stride + row * 2 + 1),
                ) /
                (2 * surface.baseHalfWidth);
              expect(widthRatio).toBeCloseTo(
                1 + 2.06 * t - 5.04 * t * t + 1.98 * t ** 3,
                5,
              );
            }
          }
        }
      } finally {
        candidate.dispose();
        baseline.dispose();
      }
    },
  );

  it.each([5, 6])(
    "has a complete consistently wound nondegenerate %s-section disk per blade",
    (segments) => {
      const candidate = sheath(segments);
      const stride = 3 * segments;
      const triangles = 4 * segments - 3;
      try {
        for (const attribute of Object.values(candidate.attributes))
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        for (let blade = 0; blade < NEAR_BLADES; blade++) {
          const used = new Set<number>();
          const edges = new Map<string, number>();
          for (let triangle = 0; triangle < triangles; triangle++) {
            const abc = [0, 1, 2].map((offset) =>
              candidate.index!.getX(
                (blade * triangles + triangle) * 3 + offset,
              ),
            );
            for (const index of abc) {
              expect(Number.isSafeInteger(index)).toBe(true);
              expect(index).toBeGreaterThanOrEqual(blade * stride);
              expect(index).toBeLessThan((blade + 1) * stride);
              used.add(index - blade * stride);
            }
            const [a, b, c] = abc.map((index) => vertex(candidate, index));
            const cross = b.sub(a).cross(c.sub(a));
            expect(cross.length()).toBeGreaterThan(1e-8);
            const averageNormal = abc.reduce(
              (sum, index) => sum.add(normal(candidate, index)),
              new THREE.Vector3(),
            );
            expect(cross.dot(averageNormal)).toBeGreaterThan(0);
            for (const [a, b] of [
              [abc[0], abc[1]],
              [abc[1], abc[2]],
              [abc[2], abc[0]],
            ]) {
              const edge = `${Math.min(a, b)}:${Math.max(a, b)}`;
              edges.set(edge, (edges.get(edge) ?? 0) + 1);
            }
          }
          expect([...used].sort((a, b) => a - b)).toEqual(
            Array.from({ length: stride }, (_, i) => i),
          );
          expect(
            [...edges.values()].every((count) => count === 1 || count === 2),
          ).toBe(true);
          expect(
            [...edges.values()].filter((count) => count === 1),
          ).toHaveLength(2 * segments + 1);
          expect(stride - edges.size + triangles).toBe(1);
        }
      } finally {
        candidate.dispose();
      }
    },
  );

  it.each([5, 6])(
    "keeps deterministic blade prefixes and leaves historical bytes unchanged after %s-section generation",
    (segments) => {
      const candidate = sheath(segments);
      const prefix = sheath(segments, 12);
      const repeat = sheath(segments);
      const baseline = geometryPair();
      const ordinary = GRASS_CONFIG.LOD_TIERS.map((tier) =>
        createClumpGeometry(tier.bladesPerClump, tier.bladeSegments),
      );
      try {
        expect(geometryDigest(candidate)).toBe(geometryDigest(repeat));
        for (const key of ["position", "normal", "uv"]) {
          const a = candidate.getAttribute(key).array;
          const b = prefix.getAttribute(key).array;
          expect(a.slice(0, b.length)).toEqual(b);
        }
        expect(candidate.index!.array.slice(0, prefix.index!.count)).toEqual(
          prefix.index!.array,
        );
        expect(ordinary.map(geometryDigest)).toEqual(LEGACY_HASHES);
        for (const [key, hash] of Object.entries(FOLDED_NATIVE142_HASHES)) {
          const attribute =
            key === "index"
              ? baseline.folded.index!
              : baseline.folded.getAttribute(key);
          if (key === "index") {
            expect(attribute.array).toBeInstanceOf(Uint16Array);
            expect(attribute.count).toBe(648);
            expect(attribute.array.byteLength).toBe(1296);
          } else expect(attribute.array).toBeInstanceOf(Float32Array);
          // Compare logical indices in the captured native typed format,
          // without replacing its historical hash or changing factory bytes.
          const values =
            key === "index"
              ? Uint32Array.from(attribute.array)
              : attribute.array;
          if (key === "index") expect(values.byteLength).toBe(2592);
          expect(
            createHash("sha256")
              .update(
                new Uint8Array(
                  values.buffer,
                  values.byteOffset,
                  values.byteLength,
                ),
              )
              .digest("hex"),
          ).toBe(hash);
        }
      } finally {
        candidate.dispose();
        prefix.dispose();
        repeat.dispose();
        baseline.dispose();
        ordinary.forEach((geometry) => geometry.dispose());
      }
    },
  );
});
