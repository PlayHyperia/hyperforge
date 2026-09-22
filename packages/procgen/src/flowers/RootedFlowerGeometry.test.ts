import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createRootedFlowerGeometry } from "./RootedFlowerGeometry.js";

const owned: THREE.BufferGeometry[] = [];
const create = (height?: number) => {
  const geometry = createRootedFlowerGeometry(
    height === undefined ? undefined : { height },
  );
  owned.push(geometry);
  return geometry;
};
afterEach(() => {
  for (const geometry of owned) geometry.dispose();
  owned.length = 0;
});

const point = (
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
) => new THREE.Vector3().fromBufferAttribute(attribute, index);

// Actual .0125h-width factory fingerprints, captured before the .018h trial
// with Node22 + real Three (factory SHA256
// 493606fa734f82d3938a7ea869d36306b9922dd698494a9b39a76b668af537f7).
// Freeze only width-independent data, not normals: shared head hinges acquire
// legitimate new averaged normals when their neighboring petal faces widen.
const widthInvariantBaselines = [
  [0.12, "2693b876ab2c3c1e1938300e2acfe3fe364394ff78315ac7e68280476c3f172f"],
  [0.25, "390c1ecd0aefb877f5200c33de385f344241f7decd761ec7e876a8392a11685a"],
  [0.38, "65499dbc35b42deff5b5a17425636a0b8e19097f59b84871d9ca777d3f395987"],
  [0.53, "ec7309ac7d8d75a47bbdee9ca2c79634fa4b1c5b28e566080d41bfcf0dc09207"],
  [0.75, "8eb940ce8cea6310ecc4a2d205aaea8f586de42c4229f3d52c83005b74895c12"],
  [0.8, "6cc23d6a3203b7e7f99ae24fb79320232a504f90185bdad58380872e7f9ee117"],
] as const;

describe("rooted meadow flower geometry", () => {
  // Real Three geometry only. These are topology/asset contracts, not native
  // lighting, wind, placement or GPU-performance approval.
  for (const [height, invariantHash] of widthInvariantBaselines) {
    describe(`height ${height}m`, () => {
      it("preserves the narrow-petal topology and all width-independent buffers", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const petal = geometry.getAttribute("flowerPetal");
        expect(position.count).toBe(362);
        expect(geometry.getIndex()!.count).toBe(584 * 3);
        const hash = createHash("sha256");
        const add = (name: string, array: THREE.TypedArray) => {
          hash.update(`${name}\0`);
          hash.update(
            Buffer.from(array.buffer, array.byteOffset, array.byteLength),
          );
        };
        add("index", geometry.getIndex()!.array);
        for (const name of ["uv", "color", "flowerHeight", "flowerPetal"])
          add(name, geometry.getAttribute(name).array);
        const stationary: number[] = [];
        for (let i = 0; i < position.count; i++) {
          // Includes the ten zero-flex shared head/petal attachment vertices.
          if (petal.getW(i) === 0)
            stationary.push(
              position.getX(i),
              position.getY(i),
              position.getZ(i),
            );
        }
        expect(stationary).toHaveLength(102 * 3);
        add("nonPetalPosition", new Float32Array(stationary));
        expect(hash.digest("hex")).toBe(invariantHash);
      });

      it("widens only the petal lateral profile while retaining the .08h flutter envelope", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const petal = geometry.getAttribute("flowerPetal");
        const fullHeight = geometry.getAttribute("flowerHeight").getY(0);
        const rows = [0.16, 0.36, 0.59, 0.81, 0.95];
        const columns = [-1, -0.5, 0, 0.5, 1];
        let changedVertices = 0;
        // Small analytic lamina reference, not a second flower generator.
        // Stem/head/leaves/index/UV/color/height/hinges use the frozen hashes.
        for (let lobe = 0; lobe < 10; lobe++) {
          const angle = (lobe / 10) * Math.PI * 2;
          const radialX = Math.cos(angle),
            radialZ = Math.sin(angle);
          const hinge = [
            height * (0.02 + 0.023 * Math.sin(Math.PI)) +
              radialX * 0.022 * height,
            0.985 * height,
            height * (-0.015 + 0.011 * Math.sin(Math.PI * 2)) +
              radialZ * 0.022 * height,
          ] as const;
          const length = height * 0.069 * (1 + 0.055 * Math.sin(lobe * 2.3));
          const sample = (t: number, across: number, widthRatio: number) => {
            const arch = Math.sin(Math.PI * t);
            const width =
              height * widthRatio * (1 + 0.04 * Math.cos(lobe * 1.7));
            const curl = Math.sin(lobe * 1.9) * height * 0.003;
            const lateral =
              across * width * arch ** 0.7 * (0.8 + 0.2 * t) + curl * arch;
            return [
              hinge[0] + radialX * length * t - radialZ * lateral,
              hinge[1] -
                height * (0.034 * arch * (1 - 0.2 * t) + 0.006 * t) +
                height * 0.009 * arch * across * across +
                height * 0.0015 * Math.sin(lobe * 1.3) * across * arch,
              hinge[2] + radialZ * length * t + radialX * lateral,
            ].map(Math.fround);
          };
          // 82 stem/head vertices precede ten 25-vertex grids + one tip each.
          for (let local = 0; local < 26; local++) {
            const vertex = 82 + lobe * 26 + local;
            const t = local === 25 ? 1 : rows[Math.floor(local / 5)];
            const across = local === 25 ? 0 : columns[local % 5];
            const expected = sample(t, across, 0.018);
            const narrow = sample(t, across, 0.0125);
            expect(point(position, vertex).toArray()).toEqual(expected);
            expect(expected[1]).toBe(narrow[1]);
            if (across === 0) expect(expected).toEqual(narrow);
            else if (expected[0] !== narrow[0] || expected[2] !== narrow[2])
              changedVertices++;
            expect(point(petal, vertex).toArray()).toEqual(
              hinge.map(Math.fround),
            );
            expect(petal.getW(vertex)).toBe(Math.fround(t * t));
            // Match the material's actual Float32 hinge/full-height contract.
            expect(
              Math.hypot(
                position.getX(vertex) - petal.getX(vertex),
                position.getZ(vertex) - petal.getZ(vertex),
              ),
            ).toBeLessThanOrEqual(0.08 * fullHeight);
          }
        }
        expect(changedVertices).toBe(200);
      });

      it("is finite, indexed and bounded, with a single material surface", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const index = geometry.getIndex();
        expect(position.itemSize).toBe(3);
        expect(position.count).toBeGreaterThan(50);
        expect(position.count).toBeLessThanOrEqual(700);
        expect(index).not.toBeNull();
        expect(index!.array).toBeInstanceOf(Uint32Array);
        expect(index!.count % 3).toBe(0);
        expect(index!.count).toBeLessThanOrEqual(1800);
        expect(
          Object.values(geometry.attributes).reduce(
            (bytes, attribute) => bytes + attribute.array.byteLength,
            index!.array.byteLength,
          ),
        ).toBe(31_624);
        expect(geometry.groups.length).toBeLessThanOrEqual(1);
        expect(geometry.morphAttributes).toEqual({});
        const used = new Set<number>();
        for (let i = 0; i < index!.count; i++) {
          const vertex = index!.getX(i);
          expect(Number.isInteger(vertex)).toBe(true);
          expect(vertex).toBeGreaterThanOrEqual(0);
          expect(vertex).toBeLessThan(position.count);
          used.add(vertex);
        }
        expect(used.size).toBe(position.count);
        for (const attribute of Object.values(geometry.attributes)) {
          expect(attribute.count).toBe(position.count);
          for (const value of attribute.array)
            expect(Number.isFinite(value)).toBe(true);
        }
      });

      it("has nondegenerate faces and normals matching their winding", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const normal = geometry.getAttribute("normal");
        const index = geometry.getIndex()!;
        for (let i = 0; i < position.count; i++) {
          expect(point(normal, i).length()).toBeCloseTo(1, 5);
        }
        for (let i = 0; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          const [a, b, c] = ids.map((id) => point(position, id));
          const face = b.clone().sub(a).cross(c.clone().sub(a));
          expect(face.length()).toBeGreaterThan(height * height * 1e-9);
          const averageNormal = ids
            .map((id) => point(normal, id))
            .reduce((sum, n) => sum.add(n), new THREE.Vector3());
          expect(
            face.normalize().dot(averageNormal.normalize()),
          ).toBeGreaterThan(0.05);
        }
      });

      it("anchors a centered ground ring and retains authored height metadata", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const data = geometry.getAttribute("flowerHeight");
        expect(data.itemSize).toBe(2);
        const roots: THREE.Vector3[] = [];
        let highest = 0;
        for (let i = 0; i < position.count; i++) {
          const p = point(position, i);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(data.getX(i)).toBe(p.y);
          expect(data.getY(i)).toBe(Math.fround(height));
          highest = Math.max(highest, p.y);
          if (p.y === 0) roots.push(p);
        }
        expect(roots.length).toBeGreaterThanOrEqual(4);
        expect(Math.min(...roots.map((p) => p.x))).toBeLessThan(0);
        expect(Math.max(...roots.map((p) => p.x))).toBeGreaterThan(0);
        expect(Math.min(...roots.map((p) => p.z))).toBeLessThan(0);
        expect(Math.max(...roots.map((p) => p.z))).toBeGreaterThan(0);
        expect(highest).toBeGreaterThan(height * 0.9);
        expect(highest).toBeLessThan(height * 1.3);
      });

      it("has rooted petal hinges on the real head rather than floating cards", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const petal = geometry.getAttribute("flowerPetal");
        const index = geometry.getIndex()!;
        expect(petal.itemSize).toBe(4);
        const groups = new Map<
          string,
          { hinge: THREE.Vector3; indices: number[] }
        >();
        const ordinary = (i: number) =>
          petal.getX(i) === 0 && petal.getY(i) === 0 && petal.getZ(i) === 0;
        for (let i = 0; i < position.count; i++) {
          const weight = petal.getW(i);
          expect(weight).toBeGreaterThanOrEqual(0);
          expect(weight).toBeLessThanOrEqual(1);
          if (ordinary(i)) {
            expect(weight).toBe(0);
            continue;
          }
          const hinge = point(petal, i);
          const key = hinge.toArray().join(",");
          let group = groups.get(key);
          if (!group) {
            group = { hinge, indices: [] };
            groups.set(key, group);
          }
          group.indices.push(i);
        }
        expect(groups.size).toBeGreaterThanOrEqual(5);
        expect(groups.size).toBeLessThanOrEqual(16);
        const triangle = new THREE.Triangle();
        const closest = new THREE.Vector3();
        for (const { hinge, indices } of groups.values()) {
          expect(
            indices.some(
              (i) =>
                petal.getW(i) === 0 &&
                point(position, i).distanceTo(hinge) < height * 1e-6,
            ),
          ).toBe(true);
          expect(indices.some((i) => petal.getW(i) === 1)).toBe(true);
          expect(
            indices.some((i) => petal.getW(i) > 0 && petal.getW(i) < 1),
          ).toBe(true);
          expect(
            indices.some(
              (i) => point(position, i).distanceTo(hinge) > height * 0.03,
            ),
          ).toBe(true);
          let distance = Infinity;
          for (let j = 0; j < index.count; j += 3) {
            const ids = [index.getX(j), index.getX(j + 1), index.getX(j + 2)];
            // Shared head/petal hinge vertices carry the petal's hinge but
            // remain stationary relative to the head (zero petal flex).
            if (!ids.every((i) => petal.getW(i) === 0)) continue;
            triangle.set(
              ...(ids.map((i) => point(position, i)) as [
                THREE.Vector3,
                THREE.Vector3,
                THREE.Vector3,
              ]),
            );
            triangle.closestPointToPoint(hinge, closest);
            distance = Math.min(distance, hinge.distanceTo(closest));
          }
          expect(distance).toBeLessThan(height * 1e-5);
        }
      });

      it("provides usable UVs, linear colors and bounds for every vertex", () => {
        const geometry = create(height);
        const position = geometry.getAttribute("position");
        const uv = geometry.getAttribute("uv");
        const colors = geometry.getAttribute("color");
        expect(uv.itemSize).toBe(2);
        expect(colors.itemSize).toBe(3);
        expect(geometry.boundingBox).not.toBeNull();
        expect(geometry.boundingSphere).not.toBeNull();
        const palette = new Set<string>();
        for (let i = 0; i < position.count; i++) {
          expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
          expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
          expect(uv.getX(i)).toBeLessThanOrEqual(1);
          expect(uv.getY(i)).toBeLessThanOrEqual(1);
          const color = point(colors, i).toArray();
          color.forEach((channel) => {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(1);
          });
          palette.add(color.join(","));
          const p = point(position, i);
          expect(geometry.boundingBox!.containsPoint(p)).toBe(true);
          expect(
            p.distanceTo(geometry.boundingSphere!.center),
          ).toBeLessThanOrEqual(
            geometry.boundingSphere!.radius + height * 1e-7,
          );
        }
        expect(palette.size).toBeGreaterThanOrEqual(3);
        expect(geometry.boundingSphere!.radius).toBeLessThan(height);
      });
    });
  }

  it("recreates identical buffers without sharing mutable geometry ownership", () => {
    const first = create();
    const second = create(0.38);
    expect(first).not.toBe(second);
    for (const name of Object.keys(first.attributes)) {
      const a = first.getAttribute(name);
      const b = second.getAttribute(name);
      expect(a).not.toBe(b);
      expect(a.array).not.toBe(b.array);
      expect(a.array).toEqual(b.array);
    }
    expect(first.getIndex()!.array).toEqual(second.getIndex()!.array);
    const before = second.getAttribute("position").getX(0);
    first.getAttribute("position").setX(0, 99);
    expect(second.getAttribute("position").getX(0)).toBe(before);
  });

  it("retains topology and proportions across supported heights", () => {
    const small = create(0.12);
    const big = create(0.8);
    expect(small.getIndex()!.array).toEqual(big.getIndex()!.array);
    for (const name of ["position", "flowerHeight", "flowerPetal"]) {
      const a = small.getAttribute(name);
      const b = big.getAttribute(name);
      expect(a.count).toBe(b.count);
      for (let i = 0; i < a.array.length; i++) {
        const unchangedWeight = name === "flowerPetal" && i % 4 === 3;
        expect(b.array[i]).toBeCloseTo(
          a.array[i] * (unchangedWeight ? 1 : 0.8 / 0.12),
          6,
        );
      }
    }
    expect(small.getAttribute("color").array).toEqual(
      big.getAttribute("color").array,
    );
    expect(small.getAttribute("uv").array).toEqual(
      big.getAttribute("uv").array,
    );
  });

  for (const height of [-Infinity, Infinity, NaN, -1, 0, 0.1199, 0.8001, 100]) {
    it(`rejects unsupported height ${height}`, () => {
      expect(() => createRootedFlowerGeometry({ height })).toThrow();
    });
  }
});
