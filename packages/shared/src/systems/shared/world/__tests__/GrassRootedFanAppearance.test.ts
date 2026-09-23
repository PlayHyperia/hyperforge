import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { getGrassBladeWindFactor } from "../GrassBladeLayout";
import {
  createClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
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
      centerRadius: 0.52,
      rootRadius: 0.025,
      facingJitter: 0.16,
      curveJitter: 0.12,
    });
    expect(Object.isFrozen(FINE_GRASS_ROOTED_FAN_COMPOSITION)).toBe(true);
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
          expect(center.length()).toBeLessThanOrEqual(0.52 + 1e-7);
          expect(center.length()).toBeGreaterThan(0.1);
          const angle = fan * Math.PI * (3 - Math.sqrt(5));
          const radius = 0.52 * Math.sqrt(radialFractions[fan]);
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
