import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  getGrassBladeLayout,
  getGrassBladeWindFactor,
  isFoldedGrassBladeLayout,
  usesGrassBladeHeightFlex,
  usesGrassCloseDetailLods,
} from "../GrassBladeLayout";
import {
  createClumpGeometry,
  createPairedMeadowClumpGeometry,
  FINE_GRASS_MEADOW_CANOPY_SHAPE,
  FINE_GRASS_MEADOW_FIELD_COMPOSITION,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
  FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
} from "../GrassVisualManager";

// Real source buffers and CPU geometry contracts only. These do not establish
// native material submission, visible coverage, root contact or GPU cost.
const LAYOUT = "fine-meadow-ribbon-v1";
const TIERS = [
  { lod: 0, blades: 21, segments: 3, stride: 7, triangles: 5 },
  { lod: 1, blades: 21, segments: 2, stride: 5, triangles: 3 },
  { lod: 2, blades: 12, segments: 2, stride: 5, triangles: 3 },
] as const;
type Tier = (typeof TIERS)[number];
// Independent literals, not expectations derived from candidate exports.
const HEIGHTS = [0.52, 0.84, 1] as const;
const WIDTHS = [0.95, 1.05, 0.8] as const;
// Opt-in field posture: the low leaf keeps proportionate horizontal reach.
// These numerical contracts do not establish final artwork or performance.
const ARCS = [0.52, 1, 0.8] as const;

type ParentBlade = Parameters<
  NonNullable<Parameters<typeof createClumpGeometry>[4]>
>[0];
const PAIRED_SHAPES = [
  { name: "raw field", shape: FINE_GRASS_MEADOW_FIELD_SHAPE },
  {
    name: "quartic field",
    shape: {
      ...FINE_GRASS_MEADOW_FIELD_SHAPE,
      BLADE_WIDTH_BEZIER_CONTROL_POINTS: [0.25, 2.3, 1.3, 0, 0] as const,
    },
  },
] as const;

function make(tier: Tier, twoRanked = false) {
  return createClumpGeometry(
    tier.blades,
    tier.segments,
    twoRanked
      ? { ...FINE_GRASS_MEADOW_FIELD_SHAPE, LEAF_ARRANGEMENT: "two-ranked-v1" }
      : FINE_GRASS_MEADOW_FIELD_SHAPE,
  );
}

function vector(
  geometry: THREE.BufferGeometry,
  attribute: "position" | "normal",
  vertex: number,
) {
  return new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute(attribute),
    vertex,
  );
}

function root(geometry: THREE.BufferGeometry, first: number) {
  return vector(geometry, "position", first)
    .add(vector(geometry, "position", first + 1))
    .multiplyScalar(0.5);
}

function widthEnvelope(t: number) {
  const u = Math.min(1, Math.max(0, t / 0.5));
  const basal = Math.min(1, Math.max(0, t / 0.2));
  return (
    (1 - 0.85 * t * t) *
    (1 + 0.35 * u * u * (3 - 2 * u)) *
    (0.25 + 0.75 * basal * basal * (3 - 2 * basal))
  );
}

describe("explicit dense meadow ribbon source geometry", () => {
  it("freezes the independent dimensions without rewriting historical recipes", () => {
    expect(FINE_GRASS_MEADOW_FIELD_COMPOSITION).toEqual({
      id: "meadow-field-v1",
      bladesPerFan: 3,
      centerRadius: 0.7,
      rootRadius: 0.065,
      facingJitter: 0.16,
      curveJitter: 0.12,
      dimensionBasis: "shared-plant-height",
      heightFactors: HEIGHTS,
      widthFactors: WIDTHS,
      arcFactors: ARCS,
      clumpSpacing: 0.5,
    });
    expect(FINE_GRASS_MEADOW_FIELD_SHAPE).toEqual({
      ...FINE_MEADOW_APPEARANCE,
      GEOMETRY_LAYOUT: LAYOUT,
      ROOT_COMPOSITION: "meadow-field-v1",
      BLADE_WIDTH_RATIO: 0.028,
      BLADE_ARC_RATIO: 0.4,
      BLADE_BASE_WIDTH_FACTOR: 0.25,
      BLADE_FULL_WIDTH_HEIGHT: 0.2,
    });
    for (const value of [
      FINE_GRASS_MEADOW_FIELD_COMPOSITION,
      FINE_GRASS_MEADOW_FIELD_SHAPE,
      FINE_GRASS_MEADOW_FIELD_COMPOSITION.heightFactors,
      FINE_GRASS_MEADOW_FIELD_COMPOSITION.widthFactors,
      FINE_GRASS_MEADOW_FIELD_COMPOSITION.arcFactors,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(FINE_MEADOW_APPEARANCE.BLADE_WIDTH_RATIO).toBe(0.045);
    expect(FINE_MEADOW_APPEARANCE.BLADE_ARC_RATIO).toBe(0.48);
    expect(GRASS_CONFIG.CLUMP_SPACING).toBe(0.7);
  });

  it.each(TIERS)(
    "uses actual finite ribbon buffers and matching non-folded layout at LOD$lod",
    (tier) => {
      const geometry = make(tier);
      try {
        const layout = getGrassBladeLayout(tier.lod, LAYOUT);
        expect(layout).toEqual({
          geometryLayout: LAYOUT,
          lod: tier.lod,
          bladesPerClump: tier.blades,
          bladeSegments: tier.segments,
          verticesPerBlade: tier.stride,
          verticesPerClump: tier.blades * tier.stride,
          trianglesPerClump: tier.blades * tier.triangles,
          rootComponents: 2,
        });
        expect(isFoldedGrassBladeLayout(tier.lod, LAYOUT)).toBe(false);
        expect(usesGrassBladeHeightFlex(LAYOUT)).toBe(true);
        expect(usesGrassCloseDetailLods(LAYOUT)).toBe(true);
        for (const name of ["position", "normal", "uv"]) {
          const attribute = geometry.getAttribute(name);
          expect(attribute.count).toBe(layout.verticesPerClump);
          expect(attribute.array).toBeInstanceOf(Float32Array);
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        }
        expect(geometry.index!.count).toBe(layout.trianglesPerClump * 3);
        expect(geometry.index!.array).toBeInstanceOf(Uint16Array);
        expect(
          Object.getOwnPropertyDescriptor(
            geometry.userData,
            "grassRootComposition",
          ),
        ).toEqual({
          value: FINE_GRASS_MEADOW_FIELD_COMPOSITION,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      } finally {
        geometry.dispose();
      }
    },
  );

  it.each(TIERS)(
    "preserves the captured field roots and middle/tall ribbons byte-for-byte at LOD$lod",
    (tier) => {
      // Independent native169 source-buffer fingerprints, captured before the
      // low-layer change. These protect the other roles without rebuilding
      // expected buffers from the candidate constants or generator.
      // Root fingerprints include positions only. Low-role normals follow
      // the changed curve derivative, verified by the independent normal test.
      const middleTall = [
        "73880966f5374e2a93296c63879635310557ecbaa684d48358cd6d6e702b8c7b",
        "073e7da623b4c02ac79010a3babbbf9a086cefc13054f54e9ffd9cd5f441e487",
        "0112f840a43142853b381408bde5496c59e3ef145aa512d30803465ebe21d788",
      ];
      const roots = [
        "5c050702519bcebefb8fb48ce13374a044cda6e6789667d38f5ee7d4fa69c11a",
        "5c050702519bcebefb8fb48ce13374a044cda6e6789667d38f5ee7d4fa69c11a",
        "9408f07d5e4f1543ab81e3d8e7066feb085988c30c79cf6def6b58a787d70635",
      ];
      const geometry = make(tier);
      try {
        const ribbonHash = createHash("sha256");
        const rootHash = createHash("sha256");
        for (const name of ["position", "normal", "uv"]) {
          const attribute = geometry.getAttribute(name);
          for (let blade = 0; blade < tier.blades; blade++) {
            const start = blade * tier.stride * attribute.itemSize;
            if ((blade + Math.floor(blade / 3)) % 3 !== 0)
              ribbonHash.update(
                Buffer.from(
                  attribute.array.slice(
                    start,
                    start + tier.stride * attribute.itemSize,
                  ).buffer,
                ),
              );
            if (name === "position")
              rootHash.update(
                Buffer.from(attribute.array.slice(start, start + 6).buffer),
              );
          }
        }
        expect(ribbonHash.digest("hex")).toBe(middleTall[tier.lod]);
        expect(rootHash.digest("hex")).toBe(roots[tier.lod]);
      } finally {
        geometry.dispose();
      }
    },
  );

  it.each(TIERS)(
    "keeps shared plant stature and slimmer meter-scale widths/reach at LOD$lod",
    (tier) => {
      const geometry = make(tier);
      const previous = createClumpGeometry(
        tier.blades,
        tier.segments,
        FINE_GRASS_MEADOW_CANOPY_SHAPE,
      );
      try {
        const position = geometry.getAttribute("position");
        for (let blade = 0; blade < tier.blades; blade++) {
          const first = blade * tier.stride;
          const fan = Math.floor(blade / 3);
          const role = (blade + fan) % 3;
          const firstFanRole = (fan * 3 + fan) % 3;
          const firstFanTip = fan * 3 * tier.stride + tier.segments * 2;
          const plantHeight =
            position.getY(firstFanTip) / (0.95 * HEIGHTS[firstFanRole]);
          const tip = vector(geometry, "position", first + tier.segments * 2);
          const center = root(geometry, first);
          const oldCenter = root(previous, first);
          const oldTip = vector(
            previous,
            "position",
            first + tier.segments * 2,
          );
          expect(plantHeight).toBeGreaterThanOrEqual(0.38 - 1e-7);
          expect(plantHeight).toBeLessThanOrEqual(0.86 + 1e-7);
          expect(
            Math.abs(tip.y - plantHeight * HEIGHTS[role] * 0.95),
          ).toBeLessThan(1e-7);
          if (role === 0)
            expect(Math.abs(tip.y - (oldTip.y * 0.52) / 0.68)).toBeLessThan(
              1e-7,
            );
          else expect(tip.y).toBe(oldTip.y);
          expect(center.distanceTo(oldCenter)).toBeLessThan(1e-7);
          const arc = tip.clone().sub(center).setY(0);
          const oldArc = oldTip.clone().sub(oldCenter).setY(0);
          const previousArcs = [1.15, 1, 0.78];
          expect(
            arc.distanceTo(
              oldArc.multiplyScalar(
                (0.4 * ARCS[role]) / (0.48 * previousArcs[role]),
              ),
            ),
          ).toBeLessThan(2e-7);
          expect(arc.length()).toBeGreaterThanOrEqual(
            plantHeight * 0.4 * ARCS[role] * 0.8 - 1e-7,
          );
          expect(arc.length()).toBeLessThanOrEqual(
            plantHeight * 0.4 * ARCS[role] * 1.2 + 1e-7,
          );
          if (role === 0) {
            const authoredLeafHeight = plantHeight * 0.52;
            const reachToHeight = arc.length() / authoredLeafHeight;
            // Independent low-leaf target: 0.4 times shared [0.8, 1.2]
            // variation. The allowance covers Float32 endpoint subtraction
            // divided by the minimum authored low-leaf height (0.1976m).
            expect(reachToHeight).toBeGreaterThanOrEqual(0.32 - 1e-6);
            expect(reachToHeight).toBeLessThanOrEqual(0.48 + 1e-6);
          }
          for (let row = 0; row < tier.segments; row++) {
            const vertex = first + row * 2;
            const width = vector(geometry, "position", vertex + 1).distanceTo(
              vector(geometry, "position", vertex),
            );
            // Subtracting two Float32 coordinates near the edge of the .7m
            // clump introduces error independently of the small leaf width.
            expect(
              Math.abs(
                width -
                  plantHeight *
                    0.028 *
                    WIDTHS[role] *
                    widthEnvelope(row / tier.segments),
              ),
            ).toBeLessThan(2e-7);
            if (row === 0)
              // Recover the nominal leaf width from its quarter-width root;
              // the same Float32 subtraction error is magnified by four.
              expect(
                Math.abs(width / 0.25 - plantHeight * 0.028 * WIDTHS[role]),
              ).toBeLessThan(8e-7);
            // Source dimensions, before instance scale: this trial must not
            // restore broad leaves merely to make its area comparison pass.
            expect(width).toBeLessThan(0.03);
            expect(width).toBeGreaterThan(row === 0 ? 0.0015 : 0.005);
          }
        }
      } finally {
        geometry.dispose();
        previous.dispose();
      }
    },
  );

  it.each(TIERS)(
    "narrows only actual root endpoints while retaining all upper vertices, normals and topology at LOD$lod",
    (tier) => {
      const geometry = make(tier);
      const fullRoots = createClumpGeometry(tier.blades, tier.segments, {
        ...FINE_GRASS_MEADOW_FIELD_SHAPE,
        BLADE_BASE_WIDTH_FACTOR: 1,
      });
      try {
        expect(geometry.index!.array).toEqual(fullRoots.index!.array);
        for (const name of ["normal", "uv"])
          expect(geometry.getAttribute(name).array).toEqual(
            fullRoots.getAttribute(name).array,
          );
        for (let blade = 0; blade < tier.blades; blade++) {
          const first = blade * tier.stride;
          const baseWidth = vector(geometry, "position", first + 1).distanceTo(
            vector(geometry, "position", first),
          );
          const previousWidth = vector(
            fullRoots,
            "position",
            first + 1,
          ).distanceTo(vector(fullRoots, "position", first));
          expect(Math.abs(baseWidth - previousWidth * 0.25)).toBeLessThan(1e-7);
          expect(
            root(geometry, first).distanceTo(root(fullRoots, first)),
          ).toBeLessThan(1e-7);
          for (let local = 0; local < tier.stride; local++) {
            const vertex = first + local;
            expect(geometry.getAttribute("position").getY(vertex)).toBe(
              fullRoots.getAttribute("position").getY(vertex),
            );
            if (local >= 2)
              expect(vector(geometry, "position", vertex).toArray()).toEqual(
                vector(fullRoots, "position", vertex).toArray(),
              );
          }
        }
        // These admitted tiers have no sample at the .2 transition: this is
        // not proof that their straight triangle edges reproduce a smooth
        // basal outline between root and first upper row.
        expect(1 / tier.segments).toBeGreaterThan(0.2);
      } finally {
        geometry.dispose();
        fullRoots.dispose();
      }
    },
  );

  it.each(
    TIERS.flatMap((tier) =>
      [false, true].map((twoRanked) => ({ ...tier, twoRanked })),
    ),
  )(
    "matches an independent smooth ribbon normal and positive winding at LOD$lod, two-ranked=$twoRanked",
    (tier) => {
      const geometry = make(tier, tier.twoRanked);
      try {
        const uv = geometry.getAttribute("uv");
        for (let blade = 0; blade < tier.blades; blade++) {
          const first = blade * tier.stride;
          const center = root(geometry, first);
          // The unchanged first upper row gives the width axis without
          // amplifying Float32 coordinate error at the narrow basal edge.
          const widthAxis = vector(geometry, "position", first + 3)
            .sub(vector(geometry, "position", first + 2))
            .normalize();
          const tip = vector(geometry, "position", first + tier.segments * 2);
          const height = tip.y / 0.95;
          const arc = tip.clone().sub(center).setY(0);
          for (let local = 0; local < tier.stride; local++) {
            const vertex = first + local;
            const atTip = local === tier.segments * 2;
            const t = atTip ? 1 : Math.floor(local / 2) / tier.segments;
            expect(uv.getY(vertex)).toBe(Math.fround(t));
            expect(uv.getX(vertex)).toBe(atTip ? 0.5 : local % 2);
            const tangent = arc
              .clone()
              .multiplyScalar(0.7 + 0.6 * t)
              .setY(height * (1.52 - 1.14 * t));
            const expected = widthAxis.clone().cross(tangent).normalize();
            const normal = vector(geometry, "normal", vertex);
            expect(normal.length()).toBeCloseTo(1, 6);
            expect(normal.distanceTo(expected)).toBeLessThan(2e-5);
            expect(Math.abs(normal.dot(widthAxis))).toBeLessThan(2e-5);
            expect(Math.abs(normal.dot(tangent.normalize()))).toBeLessThan(
              2e-5,
            );
            if (!atTip && local % 2 === 0) {
              expect(normal.toArray()).toEqual(
                vector(geometry, "normal", vertex + 1).toArray(),
              );
              const expectedCenter = center
                .clone()
                .addScaledVector(arc, 0.7 * t + 0.3 * t * t)
                .setY(height * (1.52 * t - 0.57 * t * t));
              expect(
                root(geometry, vertex).distanceTo(expectedCenter),
              ).toBeLessThan(2e-7);
            }
          }
          for (let triangle = 0; triangle < tier.triangles; triangle++) {
            const vertices = [0, 1, 2].map((corner) =>
              geometry.index!.getX(
                (blade * tier.triangles + triangle) * 3 + corner,
              ),
            );
            for (const vertex of vertices) {
              expect(vertex).toBeGreaterThanOrEqual(first);
              expect(vertex).toBeLessThan(first + tier.stride);
            }
            const [a, b, c] = vertices.map((vertex) =>
              vector(geometry, "position", vertex),
            );
            const face = b.sub(a).cross(c.sub(a));
            expect(face.length()).toBeGreaterThan(1e-8);
            for (const vertex of vertices)
              expect(
                face.dot(vector(geometry, "normal", vertex)),
              ).toBeGreaterThan(0);
          }
        }
      } finally {
        geometry.dispose();
      }
    },
  );

  it.each([false, true])(
    "retains exact LOD endpoints and the 21-to-12 prefix, two-ranked=%s",
    (twoRanked) => {
      const geometries = TIERS.map((tier) => make(tier, twoRanked));
      const repeat = make(TIERS[0], twoRanked);
      try {
        for (const name of ["position", "normal", "uv"])
          expect(repeat.getAttribute(name).array).toEqual(
            geometries[0].getAttribute(name).array,
          );
        expect(repeat.index!.array).toEqual(geometries[0].index!.array);
        for (const [i, tier] of TIERS.entries()) {
          for (let blade = 0; blade < tier.blades; blade++) {
            for (const [local, referenceLocal] of [
              [0, 0],
              [1, 1],
              [2 * tier.segments, 6],
            ]) {
              for (const name of ["position", "normal"] as const)
                expect(
                  vector(
                    geometries[i],
                    name,
                    blade * tier.stride + local,
                  ).toArray(),
                ).toEqual(
                  vector(
                    geometries[0],
                    name,
                    blade * 7 + referenceLocal,
                  ).toArray(),
                );
            }
          }
        }
        for (const name of ["position", "normal", "uv"]) {
          const far = geometries[2].getAttribute(name).array;
          expect(far).toEqual(
            geometries[1].getAttribute(name).array.slice(0, far.length),
          );
        }
        expect(geometries[2].index!.array).toEqual(
          geometries[1].index!.array.slice(0, geometries[2].index!.count),
        );
      } finally {
        [...geometries, repeat].forEach((geometry) => geometry.dispose());
      }
    },
  );

  it("admits the optional arrangement only for an unmixed field ribbon", () => {
    const selected = {
      ...FINE_GRASS_MEADOW_FIELD_SHAPE,
      LEAF_ARRANGEMENT: "two-ranked-v1" as const,
    };
    const unknown = { ...selected };
    Reflect.set(unknown, "LEAF_ARRANGEMENT", "unknown");
    for (const shape of [
      unknown,
      { ...selected, ROOT_COMPOSITION: undefined },
      { ...selected, ROOT_COMPOSITION: "meadow-canopy-v1" as const },
      { ...selected, ROOT_COMPOSITION: "progressive-fan-v1" as const },
      { ...selected, PROGRESSIVE_ROOTS: false },
      { ...selected, TUFT_BLADES: 3 },
    ])
      expect(() => createClumpGeometry(21, 3, shape)).toThrow();
    expect(() =>
      createClumpGeometry(21, 3, selected, "folded-lancet-v1"),
    ).toThrow();
    const geometry = make(TIERS[0], true);
    const original = make(TIERS[0]);
    try {
      expect(original.userData.grassLeafArrangement).toBeUndefined();
      expect(geometry.userData.grassRootComposition).toBe(
        FINE_GRASS_MEADOW_FIELD_COMPOSITION,
      );
      expect(
        Object.getOwnPropertyDescriptor(
          geometry.userData,
          "grassLeafArrangement",
        ),
      ).toEqual({
        value: FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT,
        enumerable: true,
        configurable: false,
        writable: false,
      });
      expect(FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT.basalOffsets).toEqual([
        0.01, -0.01, 0.003,
      ]);
      expect(FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT.roleBearings).toEqual([
        0,
        Math.PI,
        0,
      ]);
      for (const value of [
        FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT,
        FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT.basalOffsets,
        FINE_GRASS_TWO_RANKED_LEAF_ARRANGEMENT.roleBearings,
      ])
        expect(Object.isFrozen(value)).toBe(true);
    } finally {
      geometry.dispose();
      original.dispose();
    }
  });

  it.each(TIERS)(
    "authors compact opposed ranks without changing dimensions or budget at LOD$lod",
    (tier) => {
      const geometry = make(tier, true),
        original = make(tier);
      try {
        const position = geometry.getAttribute("position");
        expect(position.count).toBe(tier.blades * tier.stride);
        expect(geometry.index!.array).toEqual(original.index!.array);
        expect(geometry.getAttribute("uv").array).toEqual(
          original.getAttribute("uv").array,
        );
        for (let vertex = 0; vertex < position.count; vertex++)
          expect(position.getY(vertex)).toBe(
            original.getAttribute("position").getY(vertex),
          );
        const golden = Math.PI * (3 - Math.sqrt(5));
        for (let plant = 0; plant < tier.blades / 3; plant++) {
          let fraction = 0,
            bit = 0.5,
            n = plant + 1;
          while (n > 0) {
            fraction += (n % 2) * bit;
            n = Math.floor(n / 2);
            bit *= 0.5;
          }
          const center = new THREE.Vector3(
            Math.cos(plant * golden),
            0,
            Math.sin(plant * golden),
          ).multiplyScalar(0.7 * Math.sqrt(fraction));
          const byRole = [0, 1, 2].map(
            (role) => plant * 3 + ((role - (plant % 3) + 3) % 3),
          );
          const plane = root(geometry, byRole[0] * tier.stride)
            .sub(center)
            .normalize();
          const lateral = new THREE.Vector3(-plane.z, 0, plane.x);
          const turn = Math.atan2(plane.z, plane.x) - plant * golden;
          expect(
            Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))),
          ).toBeLessThanOrEqual(0.12001);
          for (const [role, blade] of byRole.entries()) {
            const first = blade * tier.stride,
              start = root(geometry, first);
            const offset = start.clone().sub(center);
            expect(start.y).toBe(0);
            expect(offset.dot(plane)).toBeCloseTo(
              [0.01, -0.01, 0.003][role],
              6,
            );
            expect(Math.abs(offset.dot(lateral))).toBeLessThan(2e-7);
            const arc = vector(geometry, "position", first + tier.segments * 2)
              .sub(start)
              .setY(0);
            const oldArc = vector(
              original,
              "position",
              first + tier.segments * 2,
            )
              .sub(root(original, first))
              .setY(0);
            expect(Math.abs(arc.length() - oldArc.length())).toBeLessThan(2e-7);
            const direction = plane.clone().multiplyScalar(role === 1 ? -1 : 1);
            expect(
              arc.clone().normalize().dot(direction),
            ).toBeGreaterThanOrEqual(Math.cos(0.12001));
            const widthAxis = vector(geometry, "position", first + 3)
              .sub(vector(geometry, "position", first + 2))
              .normalize();
            expect(Math.abs(widthAxis.dot(direction))).toBeLessThanOrEqual(
              Math.sin(0.16001),
            );
            for (let row = 0; row < tier.segments; row++) {
              const at = first + row * 2;
              const width = vector(geometry, "position", at + 1).distanceTo(
                vector(geometry, "position", at),
              );
              const previous = vector(original, "position", at + 1).distanceTo(
                vector(original, "position", at),
              );
              expect(Math.abs(width - previous)).toBeLessThan(2e-7);
            }
          }
          expect(
            root(geometry, byRole[0] * tier.stride).distanceTo(
              root(geometry, byRole[2] * tier.stride),
            ),
          ).toBeCloseTo(0.007, 6);
          // The same-side basal triangles must not occupy a common plane. This
          // rules out coincident surfaces, not every possible leaf intersection.
          const triangle = (blade: number, local: number) =>
            [0, 1, 2].map((corner) =>
              vector(
                geometry,
                "position",
                geometry.index!.getX(
                  (blade * tier.triangles + local) * 3 + corner,
                ),
              ),
            );
          for (const a of [0, 1])
            for (const b of [0, 1]) {
              const first = triangle(byRole[0], a),
                second = triangle(byRole[2], b);
              const normal = first[1]
                .clone()
                .sub(first[0])
                .cross(first[2].clone().sub(first[0]))
                .normalize();
              expect(
                Math.max(
                  ...second.map((point) =>
                    Math.abs(point.clone().sub(first[0]).dot(normal)),
                  ),
                ),
              ).toBeGreaterThan(1e-7);
            }
        }
      } finally {
        geometry.dispose();
        original.dispose();
      }
    },
  );

  it.each(TIERS)(
    "uses actual vertex heights for bounded CPU flex rather than legacy t^1.8 at LOD$lod",
    (tier) => {
      const geometry = make(tier);
      try {
        const position = geometry.getAttribute("position");
        const uv = geometry.getAttribute("uv");
        let distinctFromLegacy = 0;
        for (let blade = 0; blade < tier.blades; blade++) {
          const first = blade * tier.stride;
          const height = position.getY(first + tier.segments * 2) / 0.95;
          for (let local = 0; local < tier.stride; local++) {
            const vertex = first + local;
            const t = uv.getY(vertex);
            for (const scale of [0.7, 1, 1.3]) {
              const actual = getGrassBladeWindFactor(
                t,
                position.getY(vertex),
                scale,
                LAYOUT,
              );
              const expected =
                Math.min(1, (height * scale) / 0.86) *
                ((1.52 * t - 0.57 * t * t) / 0.95) ** 2;
              expect(actual).toBeCloseTo(expected, 6);
              expect(actual).toBeGreaterThanOrEqual(0);
              expect(actual).toBeLessThanOrEqual(1 + 1e-7);
              if (t === 0) expect(actual).toBe(0);
              if (t > 0 && t < 1 && Math.abs(actual - t ** 1.8) > 1e-3)
                distinctFromLegacy++;
              expect(
                getGrassBladeWindFactor(
                  t,
                  position.getY(vertex),
                  scale,
                  "fine-linear-sweep-3seg-v1",
                ),
              ).toBe(t ** 1.8);
            }
          }
        }
        expect(distinctFromLegacy).toBeGreaterThan(tier.blades);
      } finally {
        geometry.dispose();
      }
    },
  );

  it("accounts for denser roots and distant geometry instead of claiming a universal saving", () => {
    const geometries = TIERS.map((tier) => make(tier));
    try {
      // Infinite uniform-grid estimates only: real boundaries, habitat and
      // swept-road rejection change accepted populations and native work.
      const clumpRatio =
        (GRASS_CONFIG.CLUMP_SPACING /
          FINE_GRASS_MEADOW_FIELD_COMPOSITION.clumpSpacing) **
        2;
      expect(clumpRatio).toBeCloseTo(1.96, 12);
      // Near/mid use seven complete three-leaf fans rather than eight.
      // Far keeps its original twelve blades: it has no compensating count cut.
      const vertexRatios = [2401 / 3000, 343 / 360, 49 / 25];
      const triangleRatios = [343 / 680, 343 / 600, 49 / 25];
      const rootRatios = [343 / 200, 343 / 200, 49 / 25];
      for (const [i, tier] of TIERS.entries()) {
        const baseline = getGrassBladeLayout(
          tier.lod,
          "fine-folded-sheath-near5-v1",
        );
        expect(
          (geometries[i].getAttribute("position").count * clumpRatio) /
            baseline.verticesPerClump,
        ).toBeCloseTo(vertexRatios[i], 12);
        expect(
          ((geometries[i].index!.count / 3) * clumpRatio) /
            baseline.trianglesPerClump,
        ).toBeCloseTo(triangleRatios[i], 12);
        expect(
          (tier.blades * 2 * clumpRatio) /
            (baseline.bladesPerClump * baseline.rootComponents),
        ).toBeCloseTo(rootRatios[i], 12);
      }
    } finally {
      geometries.forEach((geometry) => geometry.dispose());
    }
  });
});
describe("unactivated paired meadow source prototype", () => {
  function slotArea(
    geometry: THREE.BufferGeometry,
    slot: number,
    triangleCount: number,
  ) {
    let area = 0;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const [a, b, c] = [0, 1, 2].map((corner) =>
        vector(
          geometry,
          "position",
          geometry.index!.getX((slot * triangleCount + triangle) * 3 + corner),
        ),
      );
      area += b.sub(a).cross(c.sub(a)).length() * 0.5;
    }
    return area;
  }

  it.each(PAIRED_SHAPES)(
    "shares exact parent roots and seeded receipts with eight vertices/six triangles: $name",
    ({ shape }) => {
      const expected: ParentBlade[] = [];
      const received: ParentBlade[] = [];
      const parent = createClumpGeometry(21, 3, shape, undefined, (blade) =>
        expected.push(blade),
      );
      const geometry = createPairedMeadowClumpGeometry(21, shape, (blade) =>
        received.push(blade),
      );
      try {
        expect(received).toEqual(expected);
        expect(received).toHaveLength(21);
        expect(received.every(Object.isFrozen)).toBe(true);
        for (const name of ["position", "normal", "uv"]) {
          const attribute = geometry.getAttribute(name);
          expect(attribute.count).toBe(168);
          expect(attribute.array).toBeInstanceOf(Float32Array);
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        }
        expect(geometry.index!.array).toBeInstanceOf(Uint16Array);
        expect(geometry.index!.count).toBe(378);
        const indices = [0, 1, 2, 1, 3, 2, 2, 3, 4, 0, 1, 5, 1, 6, 5, 5, 6, 7];
        const uv = geometry.getAttribute("uv");
        const expectedUv = [
          [0, 0],
          [1, 0],
          [0, 0.5],
          [1, 0.5],
          [0.5, 1],
          [0, 0.5],
          [1, 0.5],
          [0.5, 1],
        ];
        for (let slot = 0; slot < 21; slot++) {
          for (const local of [0, 1])
            expect(
              vector(geometry, "position", slot * 8 + local).toArray(),
            ).toEqual(vector(parent, "position", slot * 7 + local).toArray());
          expect(
            Array.from(geometry.index!.array.slice(slot * 18, slot * 18 + 18)),
          ).toEqual(indices.map((index) => slot * 8 + index));
          for (let local = 0; local < 8; local++)
            expect([
              uv.getX(slot * 8 + local),
              uv.getY(slot * 8 + local),
            ]).toEqual(expectedUv[local]);
        }
        // Calling the prototype must not replace the live near geometry/layout.
        expect(parent.getAttribute("position").count).toBe(147);
        expect(parent.index!.count).toBe(315);
        expect(getGrassBladeLayout(0, LAYOUT).verticesPerBlade).toBe(7);
      } finally {
        parent.dispose();
        geometry.dispose();
      }
    },
  );

  it.each(PAIRED_SHAPES)(
    "retains repeated buffers and the seeded twelve-slot source prefix: $name",
    ({ shape }) => {
      const full = createPairedMeadowClumpGeometry(21, shape);
      const repeat = createPairedMeadowClumpGeometry(21, shape);
      const prefix = createPairedMeadowClumpGeometry(12, shape);
      try {
        for (const name of ["position", "normal", "uv"]) {
          expect(repeat.getAttribute(name).array).toEqual(
            full.getAttribute(name).array,
          );
          const values = prefix.getAttribute(name).array;
          expect(values).toEqual(
            full.getAttribute(name).array.slice(0, values.length),
          );
        }
        expect(repeat.index!.array).toEqual(full.index!.array);
        expect(prefix.index!.array).toEqual(
          full.index!.array.slice(0, prefix.index!.count),
        );
      } finally {
        full.dispose();
        repeat.dispose();
        prefix.dispose();
      }
    },
  );

  it.each(PAIRED_SHAPES)(
    "conserves each actual parent slot area without restoring broad middle faces: $name",
    ({ shape }) => {
      const parent = createClumpGeometry(21, 3, shape);
      const geometry = createPairedMeadowClumpGeometry(21, shape);
      try {
        for (let slot = 0; slot < 21; slot++) {
          const expected = slotArea(parent, slot, 5);
          expect(
            Math.abs(slotArea(geometry, slot, 6) / expected - 1),
          ).toBeLessThan(2e-5);
          const peak = Math.max(
            ...[0, 2, 4].map((row) =>
              vector(parent, "position", slot * 7 + row + 1).distanceTo(
                vector(parent, "position", slot * 7 + row),
              ),
            ),
          );
          const widths = [2, 5].map((row) =>
            vector(geometry, "position", slot * 8 + row + 1).distanceTo(
              vector(geometry, "position", slot * 8 + row),
            ),
          );
          for (const width of widths) {
            expect(width).toBeGreaterThan(0);
            expect(width).toBeLessThanOrEqual(peak * 0.65 + 2e-7);
          }
          expect(Math.abs(widths[0] - widths[1])).toBeLessThan(2e-7);
          // One full-height leaf remains in every original slot; this is not
          // another low-canopy composition or proof of projected coverage.
          expect(vector(geometry, "position", slot * 8 + 4).y).toBe(
            vector(parent, "position", slot * 7 + 6).y,
          );
        }
      } finally {
        parent.dispose();
        geometry.dispose();
      }
    },
  );

  it.each(PAIRED_SHAPES)(
    "follows independent quadratic derivatives with a common root tangent and positive winding: $name",
    ({ shape }) => {
      const blades: ParentBlade[] = [];
      const geometry = createPairedMeadowClumpGeometry(21, shape, (blade) =>
        blades.push(blade),
      );
      try {
        for (const blade of blades) {
          const first = blade.index * 8;
          const start = new THREE.Vector3(blade.rootX, 0, blade.rootZ);
          const axis = vector(geometry, "position", first + 1)
            .sub(vector(geometry, "position", first))
            .normalize();
          const rootNormals: THREE.Vector3[] = [];
          for (const [branch, lambda] of [1, 0.9].entries()) {
            const turn = ((branch === 0 ? 1 : -1) * Math.PI) / 15;
            const control = new THREE.Vector3(
              blade.curveX * 0.35 * lambda,
              blade.height * 0.76 * lambda,
              blade.curveZ * 0.35 * lambda,
            );
            const tip = new THREE.Vector3(
              blade.curveX * Math.cos(turn) - blade.curveZ * Math.sin(turn),
              blade.height * 0.95 * lambda,
              blade.curveX * Math.sin(turn) + blade.curveZ * Math.cos(turn),
            );
            for (const [local, t] of [
              [0, 0],
              [1, 0],
              [branch === 0 ? 2 : 5, 0.5],
              [branch === 0 ? 3 : 6, 0.5],
              [branch === 0 ? 4 : 7, 1],
            ]) {
              const tangent = control
                .clone()
                .multiplyScalar(2 * (1 - 2 * t))
                .addScaledVector(tip, 2 * t);
              const expected = axis.clone().cross(tangent).normalize();
              const normal = vector(geometry, "normal", first + local);
              expect(normal.length()).toBeCloseTo(1, 6);
              expect(normal.distanceTo(expected)).toBeLessThan(2e-6);
              if (local === 0) rootNormals.push(expected);
              expect(vector(geometry, "position", first + local).y).toBeCloseTo(
                lambda * blade.height * (1.52 * t - 0.57 * t * t),
                6,
              );
            }
            const middle = root(geometry, first + (branch === 0 ? 2 : 5));
            expect(
              middle.distanceTo(
                start
                  .clone()
                  .addScaledVector(control, 0.5)
                  .addScaledVector(tip, 0.25),
              ),
            ).toBeLessThan(2e-7);
            expect(
              vector(
                geometry,
                "position",
                first + (branch === 0 ? 4 : 7),
              ).distanceTo(start.clone().add(tip)),
            ).toBeLessThan(2e-7);
          }
          expect(rootNormals[0].distanceTo(rootNormals[1])).toBeLessThan(1e-14);
          for (let triangle = 0; triangle < 6; triangle++) {
            const vertices = [0, 1, 2].map((corner) =>
              geometry.index!.getX((blade.index * 6 + triangle) * 3 + corner),
            );
            const [a, b, c] = vertices.map((vertex) =>
              vector(geometry, "position", vertex),
            );
            const face = b.sub(a).cross(c.sub(a));
            expect(face.length()).toBeGreaterThan(1e-8);
            for (const vertex of vertices)
              expect(
                face.dot(vector(geometry, "normal", vertex)),
              ).toBeGreaterThan(0);
          }
        }
      } finally {
        geometry.dispose();
      }
    },
  );

  it.each(PAIRED_SHAPES)(
    "certifies separated Float32 branch sheets above their sole common root edge: $name",
    ({ shape }) => {
      const geometry = createPairedMeadowClumpGeometry(21, shape);
      try {
        for (let slot = 0; slot < 21; slot++) {
          const first = slot * 8;
          const left = vector(geometry, "position", first);
          const edge = vector(geometry, "position", first + 1).sub(left);
          const project = (point: THREE.Vector3) =>
            edge.x * (point.z - left.z) - edge.z * (point.x - left.x);
          const rows = [
            [0, 2, 4],
            [0, 5, 7],
          ].map((branch) =>
            branch.map((local, row) => {
              const a = vector(geometry, "position", first + local);
              const b =
                row === 2 ? a : vector(geometry, "position", first + local + 1);
              expect(a.y).toBe(b.y);
              return {
                y: a.y,
                low: Math.min(project(a), project(b)),
                high: Math.max(project(a), project(b)),
              };
            }),
          );
          for (const branch of rows) {
            expect(branch[0].y).toBe(0);
            expect(Math.abs(branch[0].low)).toBe(0);
            expect(Math.abs(branch[0].high)).toBe(0);
            expect(branch[1].y).toBeGreaterThan(branch[0].y);
            expect(branch[2].y).toBeGreaterThan(branch[1].y);
          }
          const at = (branch: (typeof rows)[number], y: number) => {
            const row = y <= branch[1].y ? 0 : 1;
            const from = branch[row],
              to = branch[row + 1];
            const t = (y - from.y) / (to.y - from.y);
            return {
              low: from.low + (to.low - from.low) * t,
              high: from.high + (to.high - from.high) * t,
            };
          };
          const end = Math.min(rows[0][2].y, rows[1][2].y);
          const heights = [rows[0][1].y, rows[1][1].y, end]
            .filter((y) => y <= end)
            .sort((a, b) => a - b);
          let direction = 0;
          for (const y of heights) {
            const a = at(rows[0], y),
              b = at(rows[1], y);
            // Quantized inputs are exact Float32 values; this tolerance only
            // covers double-precision determinant/interpolation evaluation.
            const tolerance = 32 * Number.EPSILON;
            const current =
              a.low - b.high > tolerance
                ? 1
                : b.low - a.high > tolerance
                  ? -1
                  : 0;
            expect(current).not.toBe(0);
            if (direction === 0) direction = current;
            expect(current).toBe(direction);
          }
          // Interval bounds interpolate linearly between these breakpoints.
          // Strict ordering therefore rules out every interior triangle
          // intersection, not only sampled centerline or basal-plane overlap.
        }
      } finally {
        geometry.dispose();
      }
    },
  );

  it("rejects mixed or non-curved shapes instead of implicitly admitting a live layout", () => {
    for (const shape of [
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, ROOT_COMPOSITION: undefined },
      {
        ...FINE_GRASS_MEADOW_FIELD_SHAPE,
        ROOT_COMPOSITION: "meadow-canopy-v1" as const,
      },
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, PROGRESSIVE_ROOTS: false },
      {
        ...FINE_GRASS_MEADOW_FIELD_SHAPE,
        LEAF_ARRANGEMENT: "two-ranked-v1" as const,
      },
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, TUFT_BLADES: 3 },
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, BLADE_CONTROL_HEIGHT: undefined },
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, BLADE_CONTROL_HEIGHT: 0.5 },
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, BLADE_TIP_HEIGHT: 1 },
      { ...FINE_GRASS_MEADOW_FIELD_SHAPE, BLADE_CONTROL_ARC_RATIO: 0 },
    ])
      expect(() => createPairedMeadowClumpGeometry(21, shape)).toThrow();
    for (const count of [0, -1, 1.5, 22, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => createPairedMeadowClumpGeometry(count)).toThrow();
  });
});
