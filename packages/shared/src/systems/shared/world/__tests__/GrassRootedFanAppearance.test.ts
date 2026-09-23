import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { getGrassBladeWindFactor } from "../GrassBladeLayout";
import {
  createClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
  FINE_GRASS_MEADOW_CANOPY_COMPOSITION,
  FINE_GRASS_MEADOW_CANOPY_SHAPE,
  FINE_GRASS_ROOTED_FAN_COMPOSITION,
  FINE_GRASS_ROOTED_FAN_SHAPE,
  GRASS_CONFIG,
} from "../GrassVisualManager";

// Actual source geometry, not a renderer substitute. Ground contact, accepted
// road masks, visible coverage and native GPU cost require their own gates.
const VARIANTS = [
  {
    name: "sheath5",
    segments: 5,
    stride: 15,
    triangles: 17,
    crossSection: "folded-sheath-v1",
  },
  {
    name: "folded3",
    segments: 3,
    stride: 9,
    triangles: 9,
    crossSection: "folded-lancet-v1",
  },
  {
    name: "ribbon2",
    segments: 2,
    stride: 5,
    triangles: 3,
    crossSection: undefined,
  },
] as const;
type Variant = (typeof VARIANTS)[number];

// Frozen before this fan trial. Attribute order: position, normal, UV, index.
// Native148/sheath5 and native142/folded3+ribbon2 submitted Uint32 indices;
// the factory's Uint16 indices are converted only for this historical digest.
const NATIVE_HASHES = {
  sheath5: [
    "1cb5734c43644db3646bd7ca6b272bb05e893a62fd5a7b8b7472618399be5b58",
    "9898fe0e769003593cc6350f5c02aff080db2061c022b286d99cce36dcd8ddcf",
    "95602c74901c6ed8ce7e0a59df2fda3660785915dfc7282ca9401ba365674584",
    "b4995f368ffe2bc02a1c55c54d9e49b540341e7a77e30928dc6b9628ebcd83b7",
  ],
  folded3: [
    "3dad967dc9f158825106449aa2ec0a35accfdc09d7492ddd4e375072dd258386",
    "4d44fc0c9c1acb355adcb7ce42fca9379337899aedae25fedc0f2e9ca926822f",
    "8bfcb407c522d82efbcb7d771f0fe7347bbabe3eeaffc3ac77e36a323b5319a4",
    "62a209e1d96cd8f5b491e854a19c27201bc13851e6d07d6dffaf587a812fae2f",
  ],
  ribbon2: [
    "d99f6b6d66f1cfd7d1c405ace46699ad7bee3e6a33cc3f743eced1fc8a1bd871",
    "82daae81e7752c7e12a17ef0f079f3ca92dc67eb1272c077485bedcf3c35fcd3",
    "3151b5917b93984ac88c1b99647ac2a751caaba476e95228a95a3717bd841b33",
    "2cc819d1003ed3117d50fa651acc8ebfd6b54840728685b7bb9b88e7d0141a1b",
  ],
} as const;
const LEGACY_HASHES = [
  "30d43cae657ad1a55190ed6e23dda8cc7973ee4bb684a248e9d39ee851f5a109",
  "06e6a222140aa84141061eb5775b6dc46a84a8a739b69d8ee00450de8b695b2d",
  "b6d82f6b4b98e0d3a5a40813c6a5f8bac7ff94559df4e77f058a1aba4ae4a26c",
] as const;

function make(variant: Variant, blades = 24, fan = true) {
  return createClumpGeometry(
    blades,
    variant.segments,
    fan ? FINE_GRASS_ROOTED_FAN_SHAPE : FINE_GRASS_FOLDED_BLADE_SHAPE,
    variant.crossSection,
  );
}

function vector(
  g: THREE.BufferGeometry,
  attribute: "position" | "normal",
  v: number,
) {
  return new THREE.Vector3().fromBufferAttribute(g.getAttribute(attribute), v);
}

function root(g: THREE.BufferGeometry, first: number) {
  return vector(g, "position", first)
    .add(vector(g, "position", first + 1))
    .multiplyScalar(0.5);
}

function attributeHashes(g: THREE.BufferGeometry) {
  return ["position", "normal", "uv", "index"].map((name) => {
    const values =
      name === "index"
        ? Uint32Array.from(g.index!.array)
        : g.getAttribute(name).array;
    return createHash("sha256")
      .update(
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      )
      .digest("hex");
  });
}

function digest(g: THREE.BufferGeometry) {
  const hash = createHash("sha256");
  for (const attribute of [
    g.getAttribute("position"),
    g.getAttribute("normal"),
    g.getAttribute("uv"),
    g.index!,
  ]) {
    const a = attribute.array;
    hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  return hash.digest("hex");
}

/** Independent ideal surface reconstructed from Float32 roots and tip, not
 * candidate internals. Baseline dimension comparisons below prevent a wrong
 * candidate height/width/arc from merely defining its own passing oracle. */
class Surface {
  readonly root: THREE.Vector3;
  readonly widthAxis: THREE.Vector3;
  readonly ridgeAxis: THREE.Vector3;
  readonly arc: THREE.Vector3;
  readonly height: number;

  constructor(
    g: THREE.BufferGeometry,
    readonly variant: Variant,
    blade: number,
  ) {
    const first = blade * variant.stride;
    this.root = root(g, first);
    this.widthAxis = vector(g, "position", first + 1)
      .sub(vector(g, "position", first))
      .normalize();
    this.ridgeAxis = new THREE.Vector3(-this.widthAxis.z, 0, this.widthAxis.x);
    const tip = vector(g, "position", first + 2 * variant.segments);
    this.height = tip.y / 0.95;
    this.arc = tip.sub(this.root).setY(0);
  }

  point(s: number, t: number) {
    let halfWidth = this.height * 0.045 * 0.5;
    if (this.variant.crossSection) {
      halfWidth *= 1 + 2.06 * t - 5.04 * t * t + 1.98 * t ** 3;
      if (this.variant.name === "sheath5") {
        const u = Math.max(0, Math.min(1, t / 0.2));
        halfWidth *= 0.25 + 0.75 * u * u * (3 - 2 * u);
      }
    } else {
      const u = Math.max(0, Math.min(1, t / 0.5));
      halfWidth *= (1 - 0.85 * t * t) * (1 + 0.35 * u * u * (3 - 2 * u));
    }
    const ridge = this.variant.crossSection
      ? halfWidth * 0.36 * 16 * t * t * (1 - t) ** 2
      : 0;
    return this.root
      .clone()
      .addScaledVector(this.arc, 0.7 * t + 0.3 * t * t)
      .addScaledVector(this.widthAxis, s * halfWidth)
      .addScaledVector(this.ridgeAxis, (1 - s * s) * ridge)
      .setY(this.height * (1.52 * t - 0.57 * t * t));
  }
}

describe("explicit progressive rooted-fan source geometry", () => {
  it("admits only its frozen progressive composition without legacy tuft mixing", () => {
    expect(FINE_GRASS_ROOTED_FAN_COMPOSITION).toEqual({
      id: "rooted-fan-v1",
      bladesPerFan: 4,
      centerRadius: 0.7,
      rootRadius: 0.025,
      facingJitter: 0.16,
      curveJitter: 0.12,
    });
    expect(Object.isFrozen(FINE_GRASS_ROOTED_FAN_COMPOSITION)).toBe(true);
    expect(FINE_GRASS_ROOTED_FAN_COMPOSITION.centerRadius).toBe(
      GRASS_CONFIG.CLUMP_RADIUS,
    );
    expect(Object.isFrozen(FINE_GRASS_ROOTED_FAN_SHAPE)).toBe(true);
    expect(FINE_GRASS_ROOTED_FAN_SHAPE).toEqual({
      ...FINE_GRASS_FOLDED_BLADE_SHAPE,
      ROOT_COMPOSITION: "progressive-fan-v1",
    });
    const unknown = { ...FINE_GRASS_ROOTED_FAN_SHAPE };
    Reflect.set(unknown, "ROOT_COMPOSITION", "unknown-fan");
    for (const shape of [
      unknown,
      { ...FINE_GRASS_ROOTED_FAN_SHAPE, PROGRESSIVE_ROOTS: false },
      { ...FINE_GRASS_ROOTED_FAN_SHAPE, TUFT_BLADES: 4 },
      { ...FINE_GRASS_ROOTED_FAN_SHAPE, TUFT_HEIGHT_FACTORS: [0.5] },
      { ...FINE_GRASS_ROOTED_FAN_SHAPE, TUFT_ARC_FACTORS: [1.5] },
      { ...FINE_GRASS_ROOTED_FAN_SHAPE, TUFT_CENTER_RADIUS: 0.5 },
      { ...FINE_GRASS_ROOTED_FAN_SHAPE, TUFT_ROOT_RADIUS: 0.1 },
    ])
      expect(() =>
        createClumpGeometry(24, 5, shape, "folded-sheath-v1"),
      ).toThrow();
  });

  it.each(VARIANTS)(
    "retains exact 24/12/4 prefixes and topology for $name",
    (variant) => {
      const geometries = [24, 12, 4].map((n) => make(variant, n));
      const repeat = make(variant);
      try {
        expect(digest(repeat)).toBe(digest(geometries[0]));
        for (const [i, count] of [24, 12, 4].entries()) {
          const g = geometries[i];
          expect(g.getAttribute("position").count).toBe(count * variant.stride);
          expect(g.index!.count).toBe(count * variant.triangles * 3);
          expect(g.index!.array).toBeInstanceOf(Uint16Array);
          expect(
            Object.getOwnPropertyDescriptor(g.userData, "grassRootComposition"),
          ).toEqual({
            value: FINE_GRASS_ROOTED_FAN_COMPOSITION,
            enumerable: true,
            configurable: false,
            writable: false,
          });
          for (const name of ["position", "normal", "uv"]) {
            const actual = g.getAttribute(name).array;
            expect(
              geometries[0].getAttribute(name).array.slice(0, actual.length),
            ).toEqual(actual);
          }
          expect(geometries[0].index!.array.slice(0, g.index!.count)).toEqual(
            g.index!.array,
          );
        }
      } finally {
        [...geometries, repeat].forEach((g) => g.dispose());
      }
    },
  );

  it.each(VARIANTS)(
    "forms six loose noncollapsed radial fans in $name",
    (variant) => {
      const g = make(variant);
      try {
        const centers: THREE.Vector3[] = [];
        const radialFractions = [0.5, 0.25, 0.75, 0.125, 0.625, 0.375];
        for (let fan = 0; fan < 6; fan++) {
          const roots = Array.from({ length: 4 }, (_, i) =>
            root(g, (fan * 4 + i) * variant.stride),
          );
          const center = roots
            .reduce((sum, r) => sum.add(r), new THREE.Vector3())
            .multiplyScalar(0.25);
          expect(center.y).toBe(0);
          expect(center.length()).toBeLessThanOrEqual(0.7 + 1e-7);
          expect(center.length()).toBeGreaterThan(0.1);
          const angle = fan * Math.PI * (3 - Math.sqrt(5));
          const radius = 0.7 * Math.sqrt(radialFractions[fan]);
          expect(
            center.distanceTo(
              new THREE.Vector3(
                Math.cos(angle) * radius,
                0,
                Math.sin(angle) * radius,
              ),
            ),
          ).toBeLessThan(1e-7);
          centers.push(center);
          for (let i = 0; i < 4; i++) {
            const radial = roots[i].clone().sub(center);
            expect(radial.length()).toBeCloseTo(0.025, 6);
            const next = roots[(i + 1) % 4].clone().sub(center);
            expect(
              Math.abs(radial.clone().normalize().dot(next.normalize())),
            ).toBeLessThan(5e-6);
            expect(roots[i].distanceTo(roots[(i + 2) % 4])).toBeCloseTo(
              0.05,
              6,
            );
            const surface = new Surface(g, variant, fan * 4 + i);
            const direction = radial.normalize();
            expect(
              direction.dot(surface.arc.clone().normalize()),
            ).toBeGreaterThanOrEqual(Math.cos(0.12) - 1e-5);
            const tangent = new THREE.Vector3(-direction.z, 0, direction.x);
            expect(tangent.dot(surface.widthAxis)).toBeGreaterThanOrEqual(
              Math.cos(0.16) - 1e-5,
            );
          }
        }
        for (let i = 0; i < centers.length; i++)
          for (let j = 0; j < i; j++)
            expect(centers[i].distanceTo(centers[j])).toBeGreaterThan(0.1);
      } finally {
        g.dispose();
      }
    },
  );

  it.each(VARIANTS)(
    "spreads the actual $name root footprint to the clump radius at every prefix",
    (variant) => {
      // These are source-root metrics, not a rendered coverage oracle. They
      // exclude leaf reach, wind, terrain fit, masks, camera and occlusion.
      // Freeze the progressive radial stations independently of the generator;
      // its exported radius must not define this test's expected footprint.
      const fractions = [0.5, 0.25, 0.75, 0.125, 0.625, 0.375];
      for (const count of [24, 12, 4]) {
        const g = make(variant, count);
        try {
          const roots = Array.from({ length: count }, (_, blade) =>
            root(g, blade * variant.stride),
          );
          const radii = roots.map((point) => Math.hypot(point.x, point.z));
          const prefixFractions = fractions.slice(0, count / 4);
          const meanFraction =
            prefixFractions.reduce((sum, value) => sum + value, 0) /
            prefixFractions.length;
          const meanSquaredRadius =
            roots.reduce((sum, point) => sum + point.lengthSq(), 0) / count;
          // Four cardinal offsets cancel their cross terms about each fan
          // center. Thus mean(|root|²) = R² * mean(station) + ringRadius².
          const expectedMeanSquaredRadius =
            0.7 ** 2 * meanFraction + 0.025 ** 2;
          const priorNarrowMeanSquaredRadius =
            0.52 ** 2 * meanFraction + 0.025 ** 2;
          expect(meanSquaredRadius).toBeCloseTo(expectedMeanSquaredRadius, 7);
          expect(meanSquaredRadius - priorNarrowMeanSquaredRadius).toBeCloseTo(
            (0.7 ** 2 - 0.52 ** 2) * meanFraction,
            7,
          );
          expect(Math.max(...radii)).toBeCloseTo(
            0.7 * Math.sqrt(Math.max(...prefixFractions)) + 0.025,
            7,
          );
          expect(Math.min(...radii)).toBeCloseTo(
            0.7 * Math.sqrt(Math.min(...prefixFractions)) - 0.025,
            7,
          );
          expect(Math.max(...radii)).toBeLessThan(GRASS_CONFIG.CLUMP_RADIUS);
          for (const point of roots) expect(point.y).toBe(0);
          // Spreading centers must not enlarge the four-root local fan ring.
          for (let first = 0; first < count; first += 4) {
            const center = roots
              .slice(first, first + 4)
              .reduce((sum, point) => sum.add(point), new THREE.Vector3())
              .multiplyScalar(0.25);
            for (const point of roots.slice(first, first + 4))
              expect(point.distanceTo(center)).toBeCloseTo(0.025, 7);
          }
        } finally {
          g.dispose();
        }
      }
    },
  );

  it("keeps actual near/mid/far fan centers, heights and arc directions together", () => {
    const geometries = VARIANTS.map((variant) =>
      make(variant, variant.name === "ribbon2" ? 12 : 24),
    );
    try {
      for (const [i, variant] of VARIANTS.entries()) {
        const count = variant.name === "ribbon2" ? 12 : 24;
        for (let blade = 0; blade < count; blade++) {
          const reference = new Surface(geometries[0], VARIANTS[0], blade);
          const actual = new Surface(geometries[i], variant, blade);
          expect(actual.root.distanceTo(reference.root)).toBeLessThan(1e-7);
          expect(actual.arc.distanceTo(reference.arc)).toBeLessThan(1e-7);
          expect(actual.height).toBe(reference.height);
          expect(actual.widthAxis.distanceTo(reference.widthAxis)).toBeLessThan(
            2e-5,
          );
        }
      }
    } finally {
      geometries.forEach((g) => g.dispose());
    }
  });

  it.each(VARIANTS)(
    "changes placement/orientation but no sampled leaf dimensions in $name",
    (variant) => {
      const g = make(variant),
        baseline = make(variant, 24, false);
      try {
        expect(g.getAttribute("uv").array).toEqual(
          baseline.getAttribute("uv").array,
        );
        expect(g.index!.array).toEqual(baseline.index!.array);
        expect(g.getAttribute("position").array).not.toEqual(
          baseline.getAttribute("position").array,
        );
        for (let blade = 0; blade < 24; blade++) {
          const first = blade * variant.stride;
          const actual = new Surface(g, variant, blade),
            previous = new Surface(baseline, variant, blade);
          expect(actual.height).toBe(previous.height);
          expect(actual.arc.length()).toBeCloseTo(previous.arc.length(), 6);
          for (let row = 0; row < variant.segments; row++) {
            const v = first + row * 2;
            expect(
              vector(g, "position", v).distanceTo(vector(g, "position", v + 1)),
            ).toBeCloseTo(
              vector(baseline, "position", v).distanceTo(
                vector(baseline, "position", v + 1),
              ),
              6,
            );
          }
          for (let local = 0; local < variant.stride; local++) {
            const v = first + local;
            expect(g.getAttribute("position").getY(v)).toBe(
              baseline.getAttribute("position").getY(v),
            );
            if (local > 2 * variant.segments) {
              const row = local - 2 * variant.segments;
              const center = vector(g, "position", v).sub(
                root(g, first + row * 2),
              );
              const oldCenter = vector(baseline, "position", v).sub(
                root(baseline, first + row * 2),
              );
              expect(center.length()).toBeCloseTo(oldCenter.length(), 6);
            }
          }
        }
      } finally {
        g.dispose();
        baseline.dispose();
      }
    },
  );

  it.each(VARIANTS)(
    "matches an independent surface and finite-difference normals in $name",
    (variant) => {
      const g = make(variant);
      try {
        for (const attribute of Object.values(g.attributes))
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        for (let blade = 0; blade < 24; blade++) {
          const surface = new Surface(g, variant, blade);
          for (let local = 0; local < variant.stride; local++) {
            const v = blade * variant.stride + local;
            const t = g.getAttribute("uv").getY(v),
              s = 2 * g.getAttribute("uv").getX(v) - 1;
            const actual = vector(g, "normal", v);
            expect(actual.length()).toBeCloseTo(1, 6);
            expect(
              vector(g, "position", v).distanceTo(surface.point(s, t)),
            ).toBeLessThan(2e-6);
            if (t === 1) {
              const tangent = surface.arc
                .clone()
                .multiplyScalar(1.3)
                .setY(surface.height * 0.38);
              expect(
                actual.distanceTo(
                  surface.widthAxis.clone().cross(tangent).normalize(),
                ),
              ).toBeLessThan(2e-5);
            } else {
              const e = 1e-5;
              const ds = surface
                .point(s + e, t)
                .sub(surface.point(s - e, t))
                .normalize();
              const dt = surface
                .point(s, t + e)
                .sub(surface.point(s, t - e))
                .normalize();
              expect(Math.abs(actual.dot(ds))).toBeLessThan(2e-5);
              expect(Math.abs(actual.dot(dt))).toBeLessThan(2e-5);
              expect(actual.dot(ds.cross(dt).normalize())).toBeGreaterThan(
                0.99999,
              );
            }
          }
          for (let triangle = 0; triangle < variant.triangles; triangle++) {
            const abc = [0, 1, 2].map((i) =>
              g.index!.getX(3 * (blade * variant.triangles + triangle) + i),
            );
            for (const v of abc) {
              expect(v).toBeGreaterThanOrEqual(blade * variant.stride);
              expect(v).toBeLessThan((blade + 1) * variant.stride);
            }
            const [a, b, c] = abc.map((v) => vector(g, "position", v));
            const cross = b.sub(a).cross(c.sub(a));
            expect(cross.length()).toBeGreaterThan(1e-8);
            const normals = abc.reduce(
              (sum, v) => sum.add(vector(g, "normal", v)),
              new THREE.Vector3(),
            );
            expect(cross.dot(normals)).toBeGreaterThan(0);
          }
        }
      } finally {
        g.dispose();
      }
    },
  );

  it.each(VARIANTS)(
    "retains the bounded height-flex response for every source vertex in $name",
    (variant) => {
      const g = make(variant);
      try {
        for (let blade = 0; blade < 24; blade++) {
          const height = new Surface(g, variant, blade).height;
          for (let local = 0; local < variant.stride; local++) {
            const v = blade * variant.stride + local;
            const t = g.getAttribute("uv").getY(v),
              y = g.getAttribute("position").getY(v);
            for (const scale of [0.7, 1, 1.3]) {
              const actual = getGrassBladeWindFactor(
                t,
                y,
                scale,
                "fine-folded-sheath-near5-v1",
              );
              const expected =
                Math.min(1, (height * scale) / 0.86) *
                (y / (height * 0.95)) ** 2;
              expect(actual).toBeCloseTo(expected, 6);
              expect(actual).toBeGreaterThanOrEqual(0);
              expect(actual).toBeLessThanOrEqual(1 + 1e-7);
              if (t === 0) expect(actual).toBe(0);
            }
          }
        }
      } finally {
        g.dispose();
      }
    },
  );

  it("leaves every archived unselected source profile byte-for-byte unchanged", () => {
    const ordinary = GRASS_CONFIG.LOD_TIERS.map((tier) =>
      createClumpGeometry(tier.bladesPerClump, tier.bladeSegments),
    );
    const historical = VARIANTS.map((variant) =>
      make(variant, variant.name === "ribbon2" ? 12 : 24, false),
    );
    try {
      expect(ordinary.map(digest)).toEqual(LEGACY_HASHES);
      for (const [i, variant] of VARIANTS.entries())
        expect(attributeHashes(historical[i])).toEqual(
          NATIVE_HASHES[variant.name],
        );
      for (const g of [...ordinary, ...historical])
        expect(
          Object.getOwnPropertyDescriptor(g.userData, "grassRootComposition"),
        ).toBeUndefined();
    } finally {
      [...ordinary, ...historical].forEach((g) => g.dispose());
    }
  });
});

// These independent literals define the trial, rather than deriving its
// expected dimensions from the candidate's own exported factors.
const CANOPY_HEIGHT_FACTORS = [0.68, 0.84, 1] as const;
const CANOPY_WIDTH_FACTORS = [1.1, 1.25, 0.86] as const;
const CANOPY_ARC_FACTORS = [1.15, 1, 0.78] as const;
// Captured native166 tall-role positions followed by normals, raw Float32,
// ascending blade order. Only the lower and middle leaves should change.
const CANOPY_TALL_NATIVE166_HASHES = {
  sheath5: "764ef6bd595738d727ec73541f1545031d02c820565a2bd662841e9cb1a1dfd3",
  folded3: "57e233eb4a6cc37d14a3081439208ffd90c3a2a316cf478e4552a31cf49d4c4e",
  ribbon2: "9aa1d25dc2122d9777e09ddd4aeda7b8bfd5d1cf4e5eb1710ceec622c97b1119",
} as const;
const ROOTED_FAN_NATIVE164_HASHES = {
  sheath5: [
    "3a97ef4de90b18e755850a7671c357985376579197312f0d708c76790f1015ba",
    "a7f81673bf10c4699755ba690eff357209ac457210611b50e3789b0f132bcc8b",
    NATIVE_HASHES.sheath5[2],
    NATIVE_HASHES.sheath5[3],
  ],
  folded3: [
    "1517f89202778bb2c54b2db0d908eeecebd9c4037be0a81512fbf6e16a40d015",
    "d574d1a7a742756e3a3c0df879e3d6c131d36ad1b538fc723a347b47f2bfaac7",
    NATIVE_HASHES.folded3[2],
    NATIVE_HASHES.folded3[3],
  ],
  ribbon2: [
    "6ccfec3cb1247a8fa52bca49ce2726af6569767cf1408ff7252355a0a580f8f1",
    "aea9a6e2e624f868ee2e9453cfbdf1fe81579ff6cc5dde765f74c5efe23fd4da",
    NATIVE_HASHES.ribbon2[2],
    NATIVE_HASHES.ribbon2[3],
  ],
} as const;

function makeCanopy(variant: Variant, blades = 24) {
  return createClumpGeometry(
    blades,
    variant.segments,
    FINE_GRASS_MEADOW_CANOPY_SHAPE,
    variant.crossSection,
  );
}

function canopyWidthEnvelope(variant: Variant, t: number) {
  if (variant.crossSection) {
    const polynomial = 1 + 2.06 * t - 5.04 * t * t + 1.98 * t ** 3;
    if (variant.name !== "sheath5") return polynomial;
    const u = Math.max(0, Math.min(1, t / 0.2));
    return polynomial * (0.25 + 0.75 * u * u * (3 - 2 * u));
  }
  const u = Math.max(0, Math.min(1, t / 0.5));
  return (1 - 0.85 * t * t) * (1 + 0.35 * u * u * (3 - 2 * u));
}

/** Summed, azimuth-averaged vertical projection of authored triangles within
 * a height band. This is not silhouette union or screen coverage: overlapping
 * leaves count repeatedly. It catches lost leaf area before world review. */
function canopyBandArea(
  g: THREE.BufferGeometry,
  minimum: number,
  maximum: number,
) {
  const clip = (polygon: THREE.Vector3[], height: number, above: boolean) => {
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const insideA = above ? a.y >= height : a.y <= height;
      const insideB = above ? b.y >= height : b.y <= height;
      if (insideA) result.push(a);
      if (insideA !== insideB)
        result.push(a.clone().lerp(b, (height - a.y) / (b.y - a.y)));
    }
    return result;
  };
  let area = 0;
  for (let i = 0; i < g.index!.count; i += 3) {
    const triangle = [0, 1, 2].map((j) =>
      vector(g, "position", g.index!.getX(i + j)),
    );
    const polygon = clip(clip(triangle, minimum, true), maximum, false);
    for (let j = 1; j + 1 < polygon.length; j++) {
      const cross = polygon[j]
        .clone()
        .sub(polygon[0])
        .cross(polygon[j + 1].clone().sub(polygon[0]));
      // Exact uniform-azimuth integral of |cross dot view| / 2.
      area += Math.hypot(cross.x, cross.z) / Math.PI;
    }
  }
  return area;
}

/** Measure width at the first non-root row, not the narrow sheath root.
 * Ratio tests separately constrain this measurement against the old geometry,
 * so a wrong candidate width cannot certify its own passing normal oracle. */
class CanopySurface {
  readonly root: THREE.Vector3;
  readonly widthAxis: THREE.Vector3;
  readonly ridgeAxis: THREE.Vector3;
  readonly arc: THREE.Vector3;
  readonly height: number;
  readonly halfWidth: number;

  constructor(
    g: THREE.BufferGeometry,
    readonly variant: Variant,
    blade: number,
  ) {
    const first = blade * variant.stride;
    this.root = root(g, first);
    const across = vector(g, "position", first + 3).sub(
      vector(g, "position", first + 2),
    );
    this.halfWidth =
      across.length() /
      (2 * canopyWidthEnvelope(variant, 1 / variant.segments));
    this.widthAxis = across.normalize();
    this.ridgeAxis = new THREE.Vector3(-this.widthAxis.z, 0, this.widthAxis.x);
    const tip = vector(g, "position", first + 2 * variant.segments);
    this.height = tip.y / 0.95;
    this.arc = tip.sub(this.root).setY(0);
  }

  point(s: number, t: number) {
    const halfWidth = this.halfWidth * canopyWidthEnvelope(this.variant, t);
    const ridge = this.variant.crossSection
      ? halfWidth * 0.36 * 16 * t * t * (1 - t) ** 2
      : 0;
    return this.root
      .clone()
      .addScaledVector(this.arc, 0.7 * t + 0.3 * t * t)
      .addScaledVector(this.widthAxis, s * halfWidth)
      .addScaledVector(this.ridgeAxis, (1 - s * s) * ridge)
      .setY(this.height * (1.52 * t - 0.57 * t * t));
  }
}

describe("explicit meadow canopy source geometry", () => {
  it("freezes its separate composition and rejects mixed or unknown recipes", () => {
    expect(FINE_GRASS_MEADOW_CANOPY_COMPOSITION).toEqual({
      ...FINE_GRASS_ROOTED_FAN_COMPOSITION,
      id: "meadow-canopy-v1",
      bladesPerFan: 3,
      rootRadius: 0.065,
      dimensionBasis: "shared-plant-height",
      heightFactors: CANOPY_HEIGHT_FACTORS,
      widthFactors: CANOPY_WIDTH_FACTORS,
      arcFactors: CANOPY_ARC_FACTORS,
    });
    expect(Object.isFrozen(FINE_GRASS_MEADOW_CANOPY_COMPOSITION)).toBe(true);
    for (const factors of [
      FINE_GRASS_MEADOW_CANOPY_COMPOSITION.heightFactors,
      FINE_GRASS_MEADOW_CANOPY_COMPOSITION.widthFactors,
      FINE_GRASS_MEADOW_CANOPY_COMPOSITION.arcFactors,
    ])
      expect(Object.isFrozen(factors)).toBe(true);
    expect(FINE_GRASS_MEADOW_CANOPY_SHAPE).toEqual({
      ...FINE_GRASS_ROOTED_FAN_SHAPE,
      ROOT_COMPOSITION: "meadow-canopy-v1",
    });
    expect(Object.isFrozen(FINE_GRASS_MEADOW_CANOPY_SHAPE)).toBe(true);
    const unknown = { ...FINE_GRASS_MEADOW_CANOPY_SHAPE };
    Reflect.set(unknown, "ROOT_COMPOSITION", "meadow-canopy-v2");
    for (const shape of [
      unknown,
      { ...FINE_GRASS_MEADOW_CANOPY_SHAPE, PROGRESSIVE_ROOTS: false },
      { ...FINE_GRASS_MEADOW_CANOPY_SHAPE, TUFT_BLADES: 4 },
      { ...FINE_GRASS_MEADOW_CANOPY_SHAPE, TUFT_HEIGHT_FACTORS: [0.5] },
      { ...FINE_GRASS_MEADOW_CANOPY_SHAPE, TUFT_ARC_FACTORS: [1.5] },
      { ...FINE_GRASS_MEADOW_CANOPY_SHAPE, TUFT_CENTER_RADIUS: 0.5 },
      { ...FINE_GRASS_MEADOW_CANOPY_SHAPE, TUFT_ROOT_RADIUS: 0.1 },
    ])
      expect(() =>
        createClumpGeometry(24, 5, shape, "folded-sheath-v1"),
      ).toThrow();
  });

  it.each(VARIANTS)(
    "keeps deterministic 24/12/4 prefixes, topology and immutable ownership in $name",
    (variant) => {
      const geometries = [24, 12, 4].map((count) => makeCanopy(variant, count));
      const repeat = makeCanopy(variant);
      try {
        expect(digest(repeat)).toBe(digest(geometries[0]));
        for (const [i, count] of [24, 12, 4].entries()) {
          const g = geometries[i];
          expect(g.getAttribute("position").count).toBe(count * variant.stride);
          expect(g.index!.count).toBe(count * variant.triangles * 3);
          expect(g.index!.array).toBeInstanceOf(Uint16Array);
          expect(
            Object.getOwnPropertyDescriptor(g.userData, "grassRootComposition"),
          ).toEqual({
            value: FINE_GRASS_MEADOW_CANOPY_COMPOSITION,
            enumerable: true,
            configurable: false,
            writable: false,
          });
          for (const name of ["position", "normal", "uv"])
            expect(g.getAttribute(name).array).toEqual(
              geometries[0]
                .getAttribute(name)
                .array.slice(0, g.getAttribute(name).array.length),
            );
          expect(g.index!.array).toEqual(
            geometries[0].index!.array.slice(0, g.index!.count),
          );
        }
      } finally {
        [...geometries, repeat].forEach((g) => g.dispose());
      }
    },
  );

  it.each(VARIANTS)(
    "applies each rotated fan role to actual Float32 stature, width and arc in $name",
    (variant) => {
      const g = makeCanopy(variant),
        baseline = make(variant);
      try {
        expect(g.getAttribute("uv").array).toEqual(
          baseline.getAttribute("uv").array,
        );
        expect(g.index!.array).toEqual(baseline.index!.array);
        for (let blade = 0; blade < 24; blade++) {
          const fan = Math.floor(blade / 3);
          const role = (blade + fan) % 3;
          const actual = new CanopySurface(g, variant, blade);
          const previous = new CanopySurface(baseline, variant, blade);
          const fanHeight = new CanopySurface(baseline, variant, fan * 3)
            .height;
          const plantRatio = fanHeight / previous.height;
          const heightRatio = plantRatio * CANOPY_HEIGHT_FACTORS[role];
          expect(actual.height / fanHeight).toBeCloseTo(
            CANOPY_HEIGHT_FACTORS[role],
            6,
          );
          expect(actual.halfWidth / previous.halfWidth).toBeCloseTo(
            plantRatio * CANOPY_WIDTH_FACTORS[role],
            5,
          );
          expect(2 * actual.halfWidth).toBeCloseTo(
            fanHeight * 0.045 * CANOPY_WIDTH_FACTORS[role],
            7,
          );
          expect(actual.arc.length() / previous.arc.length()).toBeCloseTo(
            plantRatio * CANOPY_ARC_FACTORS[role],
            6,
          );
          // Fan cardinality changes the nominal direction, never the old
          // per-blade facing/curvature random samples.
          const golden = Math.PI * (3 - Math.sqrt(5));
          const angle = fan * golden + ((blade % 3) / 3) * Math.PI * 2;
          const oldAngle =
            Math.floor(blade / 4) * golden + ((blade % 4) / 4) * Math.PI * 2;
          const rotate = (v: THREE.Vector3) =>
            new THREE.Vector3(
              v.x * Math.cos(angle - oldAngle) -
                v.z * Math.sin(angle - oldAngle),
              v.y,
              v.x * Math.sin(angle - oldAngle) +
                v.z * Math.cos(angle - oldAngle),
            );
          expect(
            actual.arc
              .clone()
              .normalize()
              .distanceTo(rotate(previous.arc).normalize()),
          ).toBeLessThan(2e-6);
          expect(
            actual.widthAxis.distanceTo(rotate(previous.widthAxis)),
          ).toBeLessThan(2e-5);
          for (let row = 0; row < variant.segments; row++) {
            const first = blade * variant.stride + row * 2;
            const width = vector(g, "position", first).distanceTo(
              vector(g, "position", first + 1),
            );
            const oldWidth = vector(baseline, "position", first).distanceTo(
              vector(baseline, "position", first + 1),
            );
            expect(width).toBeCloseTo(
              oldWidth * plantRatio * CANOPY_WIDTH_FACTORS[role],
              6,
            );
          }
          for (let local = 0; local < variant.stride; local++) {
            const v = blade * variant.stride + local;
            expect(g.getAttribute("position").getY(v)).toBeCloseTo(
              baseline.getAttribute("position").getY(v) * heightRatio,
              7,
            );
          }
        }
      } finally {
        g.dispose();
        baseline.dispose();
      }
    },
  );

  it.each(VARIANTS)(
    "forms eight progressive three-root plants with a bounded partial prefix in $name",
    (variant) => {
      const stations = [0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875, 0.0625];
      for (const count of [24, 12, 4]) {
        const g = makeCanopy(variant, count);
        try {
          const roots = Array.from({ length: count }, (_, blade) =>
            root(g, blade * variant.stride),
          );
          for (let fan = 0; fan < Math.ceil(count / 3); fan++) {
            const angle = fan * Math.PI * (3 - Math.sqrt(5));
            const radius = 0.7 * Math.sqrt(stations[fan]);
            const center = new THREE.Vector3(
              Math.cos(angle) * radius,
              0,
              Math.sin(angle) * radius,
            );
            for (let blade = 0; blade < Math.min(3, count - fan * 3); blade++) {
              const direction = angle + (blade / 3) * Math.PI * 2;
              const expected = center
                .clone()
                .add(
                  new THREE.Vector3(
                    Math.cos(direction) * 0.065,
                    0,
                    Math.sin(direction) * 0.065,
                  ),
                );
              expect(roots[fan * 3 + blade].distanceTo(expected)).toBeLessThan(
                1e-7,
              );
              expect(roots[fan * 3 + blade].y).toBe(0);
            }
          }
          const maximumRootRadius = Math.max(
            ...roots.map((point) => point.length()),
          );
          expect(maximumRootRadius).toBeLessThanOrEqual(
            0.7 * Math.sqrt(0.875) + 0.065 + 1e-7,
          );
          if (count === 24) expect(maximumRootRadius).toBeGreaterThan(0.7);
        } finally {
          g.dispose();
        }
      }
      // This is an authored-root bound, not reuse of historical road/water fits.
    },
  );

  it("retains roots, role dimensions and directions across the actual near/mid/far tiers", () => {
    const geometries = VARIANTS.map((variant) =>
      makeCanopy(variant, variant.name === "ribbon2" ? 12 : 24),
    );
    try {
      for (const [i, variant] of VARIANTS.entries())
        for (
          let blade = 0;
          blade < (variant.name === "ribbon2" ? 12 : 24);
          blade++
        ) {
          const actual = new CanopySurface(geometries[i], variant, blade);
          const near = new CanopySurface(geometries[0], VARIANTS[0], blade);
          expect(actual.root.distanceTo(near.root)).toBeLessThan(1e-7);
          expect(actual.arc.distanceTo(near.arc)).toBeLessThan(1e-7);
          expect(actual.height).toBe(near.height);
          expect(actual.halfWidth).toBeCloseTo(near.halfWidth, 7);
          expect(actual.widthAxis.distanceTo(near.widthAxis)).toBeLessThan(
            2e-5,
          );
        }
    } finally {
      geometries.forEach((g) => g.dispose());
    }
  });

  it.each(VARIANTS)(
    "matches measured-width independent surfaces, normals and nondegenerate winding in $name",
    (variant) => {
      const g = makeCanopy(variant);
      try {
        for (const attribute of Object.values(g.attributes))
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        for (let blade = 0; blade < 24; blade++) {
          const surface = new CanopySurface(g, variant, blade);
          for (let local = 0; local < variant.stride; local++) {
            const v = blade * variant.stride + local;
            const t = g.getAttribute("uv").getY(v),
              s = 2 * g.getAttribute("uv").getX(v) - 1;
            const actual = vector(g, "normal", v);
            expect(actual.length()).toBeCloseTo(1, 6);
            expect(
              vector(g, "position", v).distanceTo(surface.point(s, t)),
            ).toBeLessThan(2e-6);
            if (t === 1) {
              const tangent = surface.arc
                .clone()
                .multiplyScalar(1.3)
                .setY(surface.height * 0.38);
              expect(
                actual.distanceTo(
                  surface.widthAxis.clone().cross(tangent).normalize(),
                ),
              ).toBeLessThan(3e-5);
            } else {
              const e = 1e-5;
              const ds = surface
                .point(s + e, t)
                .sub(surface.point(s - e, t))
                .normalize();
              const dt = surface
                .point(s, t + e)
                .sub(surface.point(s, t - e))
                .normalize();
              expect(Math.abs(actual.dot(ds))).toBeLessThan(3e-5);
              expect(Math.abs(actual.dot(dt))).toBeLessThan(3e-5);
              expect(actual.dot(ds.cross(dt).normalize())).toBeGreaterThan(
                0.99999,
              );
            }
          }
          for (let triangle = 0; triangle < variant.triangles; triangle++) {
            const abc = [0, 1, 2].map((i) =>
              g.index!.getX(3 * (blade * variant.triangles + triangle) + i),
            );
            for (const v of abc) {
              expect(v).toBeGreaterThanOrEqual(blade * variant.stride);
              expect(v).toBeLessThan((blade + 1) * variant.stride);
            }
            const [a, b, c] = abc.map((v) => vector(g, "position", v));
            const cross = b.sub(a).cross(c.sub(a));
            expect(cross.length()).toBeGreaterThan(1e-8);
            const normals = abc.reduce(
              (sum, v) => sum.add(vector(g, "normal", v)),
              new THREE.Vector3(),
            );
            expect(cross.dot(normals)).toBeGreaterThan(0);
          }
        }
      } finally {
        g.dispose();
      }
    },
  );

  it.each(VARIANTS)(
    "bounds every source height and height-flex amplitude by the shared plant envelope in $name",
    (variant) => {
      const g = makeCanopy(variant),
        baseline = make(variant);
      try {
        g.computeBoundingBox();
        g.computeBoundingSphere();
        expect(g.boundingBox!.min.y).toBe(0);
        expect(g.boundingBox!.max.y).toBeLessThanOrEqual(0.86 * 0.95 + 1e-7);
        expect(Number.isFinite(g.boundingSphere!.radius)).toBe(true);
        for (let blade = 0; blade < 24; blade++) {
          const surface = new CanopySurface(g, variant, blade);
          const fan = Math.floor(blade / 3),
            role = (blade + fan) % 3;
          const fanHeight = new CanopySurface(baseline, variant, fan * 3)
            .height;
          expect(surface.height).toBeCloseTo(
            fanHeight * CANOPY_HEIGHT_FACTORS[role],
            7,
          );
          expect(surface.height).toBeLessThanOrEqual(fanHeight + 1e-7);
          expect(surface.height).toBeLessThanOrEqual(0.86 + 1e-7);
          for (let local = 0; local < variant.stride; local++) {
            const v = blade * variant.stride + local,
              t = g.getAttribute("uv").getY(v),
              y = g.getAttribute("position").getY(v);
            expect(g.boundingBox!.containsPoint(vector(g, "position", v))).toBe(
              true,
            );
            for (const scale of [0.7, 1, 1.3]) {
              const actual = getGrassBladeWindFactor(
                t,
                y,
                scale,
                "fine-folded-sheath-near5-v1",
              );
              const curve = 1.52 * t - 0.57 * t * t;
              const sharedPlantEnvelope =
                Math.min(1, (fanHeight * scale) / 0.86) * (curve / 0.95) ** 2;
              const expected =
                Math.min(1, (surface.height * scale) / 0.86) *
                (y / (surface.height * 0.95)) ** 2;
              expect(actual).toBeCloseTo(expected, 6);
              expect(actual).toBeGreaterThanOrEqual(0);
              expect(actual).toBeLessThanOrEqual(sharedPlantEnvelope + 1e-7);
              expect(actual).toBeLessThanOrEqual(1 + 1e-7);
              if (t === 0) expect(actual).toBe(0);
            }
          }
        }
      } finally {
        g.dispose();
        baseline.dispose();
      }
    },
  );

  it.each(VARIANTS)(
    "restores low/mid authored leaf area without broadening native166 tall leaves in $name",
    (variant) => {
      const blades = variant.name === "ribbon2" ? 12 : 24;
      const g = makeCanopy(variant, blades),
        baseline = make(variant, blades);
      try {
        // Recover coverage in the lower two strata, not the deliberately finer
        // upper silhouette. World occlusion, retained masks, flower readability
        // and native fragment cost still require an actual scene comparison.
        for (const [minimum, maximum, floor] of [
          [0, 0.2, 0.95],
          [0.2, 0.4, 0.85],
        ]) {
          const ratio =
            canopyBandArea(g, minimum, maximum) /
            canopyBandArea(baseline, minimum, maximum);
          expect(ratio).toBeGreaterThan(floor);
          expect(ratio).toBeLessThan(1.3);
        }
        const hash = createHash("sha256");
        for (const name of ["position", "normal"]) {
          const values = g.getAttribute(name).array;
          for (let blade = 0; blade < blades; blade++) {
            if ((blade + Math.floor(blade / 3)) % 3 !== 2) continue;
            const first = blade * variant.stride * 3;
            const selected = values.slice(first, first + variant.stride * 3);
            hash.update(
              new Uint8Array(
                selected.buffer,
                selected.byteOffset,
                selected.byteLength,
              ),
            );
          }
        }
        expect(hash.digest("hex")).toBe(
          CANOPY_TALL_NATIVE166_HASHES[variant.name],
        );
      } finally {
        g.dispose();
        baseline.dispose();
      }
    },
  );

  it("retains all three immutable native164 rooted-fan attribute hashes", () => {
    for (const variant of VARIANTS) {
      const g = make(variant, variant.name === "ribbon2" ? 12 : 24);
      try {
        expect(attributeHashes(g)).toEqual(
          ROOTED_FAN_NATIVE164_HASHES[variant.name],
        );
      } finally {
        g.dispose();
      }
    }
  });
});
