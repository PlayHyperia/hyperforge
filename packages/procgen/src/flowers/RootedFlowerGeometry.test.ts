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
const createSprig = (height: number) => {
  const geometry = createRootedFlowerGeometry({
    height,
    variant: "meadow-sprig-v1",
  });
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

describe("opt-in two-headed meadow sprig geometry", () => {
  // Actual authored buffers/topology only. Native appearance, wind, material
  // admission and placement are checked by their real owner; these tests do
  // not certify lighting, per-pixel contact or frame-time performance.
  for (const [height] of widthInvariantBaselines) {
    describe(`height ${height}m`, () => {
      it("leaves explicit and implicit original variants byte-identical", () => {
        const original = create(height);
        const explicit = createRootedFlowerGeometry({
          height,
          variant: "single-head-v1",
        });
        owned.push(explicit);
        expect(explicit.name).toBe(original.name);
        expect(explicit.getIndex()!.array).toEqual(original.getIndex()!.array);
        expect(Object.keys(explicit.attributes)).toEqual(
          Object.keys(original.attributes),
        );
        for (const name of Object.keys(original.attributes))
          expect(explicit.getAttribute(name).array).toEqual(
            original.getAttribute(name).array,
          );
        expect(explicit.boundingBox).toEqual(original.boundingBox);
        expect(explicit.boundingSphere).toEqual(original.boundingSphere);
      });

      it("stays inside the unchanged static envelope and exact full height", () => {
        const original = create(height),
          sprig = createSprig(height);
        const base = original.getAttribute("position"),
          position = sprig.getAttribute("position");
        const metadata = sprig.getAttribute("flowerHeight"),
          petal = sprig.getAttribute("flowerPetal");
        let baseRadius = 0,
          radius = 0,
          highest = 0,
          roots = 0;
        for (let i = 0; i < base.count; i++)
          baseRadius = Math.max(
            baseRadius,
            Math.hypot(base.getX(i), base.getZ(i)),
          );
        for (let i = 0; i < position.count; i++) {
          const p = point(position, i);
          expect(original.boundingBox!.containsPoint(p)).toBe(true);
          expect(sprig.boundingBox!.containsPoint(p)).toBe(true);
          expect(
            p.distanceTo(sprig.boundingSphere!.center),
          ).toBeLessThanOrEqual(sprig.boundingSphere!.radius + height * 1e-7);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(metadata.getX(i)).toBe(p.y);
          expect(metadata.getY(i)).toBe(Math.fround(height));
          highest = Math.max(highest, p.y);
          radius = Math.max(radius, Math.hypot(p.x, p.z));
          if (p.y === 0) {
            roots++;
            expect(petal.getW(i)).toBe(0);
            expect(point(petal, i).toArray()).toEqual([0, 0, 0]);
          }
        }
        expect(roots).toBe(11); // One ten-sided ground ring plus its shared cap.
        expect(highest).toBe(Math.fround(height));
        expect(radius).toBe(baseRadius); // Existing leaves still own the extrema.
        expect(sprig.boundingSphere!.radius).toBeLessThan(height);
      });

      it("widens only the sprig's .031h lateral petals to .041h without changing its actual bounds", () => {
        const geometry = createSprig(height),
          position = geometry.getAttribute("position"),
          metadata = geometry.getAttribute("flowerHeight"),
          petal = geometry.getAttribute("flowerPetal");
        const original = geometry.clone();
        owned.push(original);
        const originalPosition = original.getAttribute("position");
        let changed = 0;
        // Independent, local lamina oracle only: the existing support, index,
        // welded-head, original-variant and normal tests remain authoritative.
        for (let head = 0; head < 2; head++) {
          const scale = head === 0 ? 1 : 0.9;
          const center =
            head === 0
              ? [
                  height * (0.02 + 0.023 * Math.sin(Math.PI)),
                  height * (-0.015 + 0.011 * Math.sin(Math.PI * 2)),
                ]
              : [height * 0.012, height * 0.095];
          const top = head === 0 ? height : height * 0.835;
          for (let lobe = 0; lobe < 5; lobe++) {
            const variation = head * 5 + lobe;
            const angle =
              (head === 0 ? 0 : Math.PI / 4) + (lobe / 5) * Math.PI * 2;
            const rx = Math.cos(angle),
              rz = Math.sin(angle);
            const hinge = [
              center[0] + rx * 0.022 * height * scale,
              top - height * 0.015 * scale,
              center[1] + rz * 0.022 * height * scale,
            ];
            const sample = (t: number, across: number, widthRatio: number) => {
              const arch = Math.sin(Math.PI * t);
              const length =
                height *
                scale *
                0.068 *
                (1 + 0.025 * Math.sin(variation * 2.3));
              const width =
                height *
                scale *
                widthRatio *
                (1 + 0.025 * Math.cos(variation * 1.7));
              const lateral = across * width * arch ** 0.48 * (0.68 + 0.32 * t);
              const radial =
                length * t - height * scale * 0.003 * across * across * arch;
              const cup = height * scale * 0.01 * arch * across * across;
              return [
                hinge[0] + rx * radial - rz * lateral,
                hinge[1] +
                  height * scale * (-0.012 * arch - 0.002 * t + 0.006 * t * t) +
                  cup,
                hinge[2] + rz * radial + rx * lateral,
              ].map(Math.fround);
            };
            for (let local = 0; local < 21; local++) {
              const vertex = 123 + variation * 21 + local;
              const t =
                local === 20
                  ? 1
                  : [0.18, 0.46, 0.73, 0.93][Math.floor(local / 5)];
              const across =
                local === 20 ? 0 : [-1, -0.5, 0, 0.5, 1][local % 5];
              const expected = sample(t, across, 0.041);
              const previous = sample(t, across, 0.031);
              expect(point(position, vertex).toArray()).toEqual(expected);
              expect(expected[1]).toBe(previous[1]);
              expect(metadata.getX(vertex)).toBe(previous[1]);
              expect(point(petal, vertex).toArray()).toEqual(
                hinge.map(Math.fround),
              );
              expect(petal.getW(vertex)).toBe(Math.fround(t * t));
              if (across === 0) expect(expected).toEqual(previous);
              else {
                expect(expected).not.toEqual(previous);
                changed++;
              }
              originalPosition.setXYZ(
                vertex,
                previous[0],
                previous[1],
                previous[2],
              );
            }
          }
        }
        expect(changed).toBe(160);
        original.computeBoundingBox();
        original.computeBoundingSphere();
        expect(geometry.boundingBox).toEqual(original.boundingBox);
        expect(geometry.boundingSphere).toEqual(original.boundingSphere);
      });

      it("keeps all rotated flutter hinges bounded and adjacent petals in disjoint convex sectors", () => {
        const geometry = createSprig(height),
          position = geometry.getAttribute("position");
        const petal = geometry.getAttribute("flowerPetal"),
          index = geometry.getIndex()!;
        const fullHeight = geometry.getAttribute("flowerHeight").getY(0);
        const key = (id: number) => point(petal, id).toArray().join(",");
        type PetalGroup = {
          hinge: THREE.Vector3;
          ids: number[];
          triangles: number;
        };
        const groups = new Map<string, PetalGroup>();
        for (let i = 0; i < position.count; i++) {
          const hinge = point(petal, i);
          if (hinge.lengthSq() === 0) continue;
          const group = groups.get(key(i)) ?? { hinge, ids: [], triangles: 0 };
          group.ids.push(i);
          groups.set(key(i), group);
        }
        expect(position.count).toBe(353);
        expect(index.count).toBe(586 * 3);
        expect(groups.size).toBe(10);
        for (let i = 0; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          const flexed = ids.find((id) => petal.getW(id) > 0);
          if (flexed === undefined) continue;
          const group = groups.get(key(flexed))!;
          for (const id of ids) expect(key(id)).toBe(key(flexed));
          group.triangles++;
        }
        const heads = new Map<number, PetalGroup[]>();
        for (const group of groups.values()) {
          expect(group.ids).toHaveLength(22);
          expect(group.triangles).toBe(32);
          const head = heads.get(group.hinge.y) ?? [];
          head.push(group);
          heads.set(group.hinge.y, head);
        }
        expect(heads.size).toBe(2);
        const heightIntervals = [...heads.values()]
          .map((head) => {
            const ys = head.flatMap((group) =>
              group.ids.map((id) => position.getY(id)),
            );
            return { min: Math.min(...ys), max: Math.max(...ys) };
          })
          .sort((a, b) => a.min - b.min);
        // All actual petal triangle vertices, including shared hinges, lie in
        // these disjoint slabs. Triangle interiors are convex combinations,
        // so the two static heads' petals cannot intersect one another.
        expect(heightIntervals[0].max).toBeLessThan(heightIntervals[1].min);
        for (const head of heads.values()) {
          expect(head).toHaveLength(5);
          // Five evenly spaced actual attachment points determine the head
          // centre, independent of the generator's authored centre formula.
          const center = head
            .reduce((sum, group) => sum.add(group.hinge), new THREE.Vector3())
            .multiplyScalar(1 / 5);
          for (const yaw of [
            0,
            Math.PI / 7,
            Math.PI / 2,
            Math.PI,
            Math.PI * 1.75,
          ]) {
            const rotation = new THREE.Matrix4().makeRotationY(yaw);
            const rotatedCenter = center.clone().applyMatrix4(rotation);
            const sectors = head
              .map((group) => {
                const hinge = group.hinge.clone().applyMatrix4(rotation);
                const direction = new THREE.Vector2(
                  hinge.x - rotatedCenter.x,
                  hinge.z - rotatedCenter.z,
                ).normalize();
                let minAngle = Infinity,
                  maxAngle = -Infinity;
                for (const id of group.ids) {
                  const p = point(position, id).applyMatrix4(rotation);
                  expect(
                    Math.hypot(p.x - hinge.x, p.z - hinge.z),
                  ).toBeLessThanOrEqual(0.08 * fullHeight);
                  const offset = new THREE.Vector2(
                    p.x - rotatedCenter.x,
                    p.z - rotatedCenter.z,
                  );
                  const forward = offset.dot(direction);
                  expect(forward).toBeGreaterThan(0);
                  const angle = Math.atan2(
                    direction.x * offset.y - direction.y * offset.x,
                    forward,
                  );
                  minAngle = Math.min(minAngle, angle);
                  maxAngle = Math.max(maxAngle, angle);
                }
                expect(
                  Math.max(Math.abs(minAngle), Math.abs(maxAngle)),
                ).toBeLessThan(Math.PI / 5);
                return {
                  axis: Math.atan2(direction.y, direction.x),
                  minAngle,
                  maxAngle,
                };
              })
              .sort((a, b) => a.axis - b.axis);
            for (let i = 0; i < sectors.length; i++) {
              const current = sectors[i],
                next = sectors[(i + 1) % sectors.length];
              const nextAxis =
                next.axis + (i === sectors.length - 1 ? Math.PI * 2 : 0);
              expect(current.axis + current.maxAngle).toBeLessThan(
                nextAxis + next.minAngle,
              );
            }
            // Each projected triangle is a convex combination of vertices in
            // one <pi wedge. Strictly separated wedges therefore prove no
            // adjacent same-head triangle intersection, including interiors.
            // Neither static proof claims wind-deformed collision freedom.
          }
        }
      });

      it("uses 353 real vertices and 586 nondegenerate correctly wound triangles", () => {
        const geometry = createSprig(height),
          position = geometry.getAttribute("position");
        const normal = geometry.getAttribute("normal"),
          index = geometry.getIndex()!;
        expect(geometry.name).toBe("RootedMeadowSprig");
        expect(position.count).toBe(353);
        expect(index.count).toBe(586 * 3);
        expect(position.count).toBeLessThanOrEqual(700);
        expect(index.count).toBeLessThanOrEqual(600 * 3);
        expect(index.array).toBeInstanceOf(Uint32Array);
        expect(geometry.groups).toEqual([]);
        expect(geometry.morphAttributes).toEqual({});
        expect(Object.keys(geometry.attributes).sort()).toEqual(
          [
            "position",
            "normal",
            "color",
            "uv",
            "flowerHeight",
            "flowerPetal",
          ].sort(),
        );
        for (const attribute of Object.values(geometry.attributes)) {
          expect(attribute.array).toBeInstanceOf(Float32Array);
          expect(attribute.count).toBe(position.count);
          expect(attribute.normalized).toBe(false);
          for (const value of attribute.array)
            expect(Number.isFinite(value)).toBe(true);
        }
        const used = new Set<number>();
        for (let i = 0; i < position.count; i++)
          expect(point(normal, i).length()).toBeCloseTo(1, 5);
        for (let i = 0; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          for (const id of ids) {
            expect(Number.isInteger(id)).toBe(true);
            expect(id).toBeGreaterThanOrEqual(0);
            expect(id).toBeLessThan(position.count);
            used.add(id);
          }
          const [a, b, c] = ids.map((id) => point(position, id));
          const face = b.clone().sub(a).cross(c.clone().sub(a));
          expect(face.length()).toBeGreaterThan(height * height * 1e-9);
          const average = ids.reduce(
            (sum, id) => sum.add(point(normal, id)),
            new THREE.Vector3(),
          );
          expect(face.normalize().dot(average.normalize())).toBeGreaterThan(
            0.05,
          );
        }
        expect(used.size).toBe(position.count);
        for (const name of ["uv", "color"])
          for (const value of geometry.getAttribute(name).array) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
      });

      it("welds both heads into one closed branched support without an internal stem wall", () => {
        const geometry = createSprig(height),
          position = geometry.getAttribute("position");
        const index = geometry.getIndex()!,
          petal = geometry.getAttribute("flowerPetal");
        // Body is authored first: main stem/root, branch, then both heads.
        const supportVertices = 123;
        for (let i = 0; i < supportVertices; i++) expect(petal.getW(i)).toBe(0);
        const supportEdges = new Map<
          string,
          { count: number; direction: number }
        >();
        const adjacency = Array.from(
          { length: position.count },
          () => new Set<number>(),
        );
        let supportFaces = 0;
        for (let i = 0; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          const support = ids.every((id) => id < supportVertices);
          if (support) supportFaces++;
          // The two old sidewall faces are removed, not hidden inside a tube.
          expect(ids.slice().sort((a, b) => a - b)).not.toEqual([11, 12, 21]);
          expect(ids.slice().sort((a, b) => a - b)).not.toEqual([12, 21, 22]);
          for (let j = 0; j < 3; j++) {
            const a = ids[j],
              b = ids[(j + 1) % 3];
            adjacency[a].add(b);
            adjacency[b].add(a);
            if (!support) continue;
            const key = `${Math.min(a, b)},${Math.max(a, b)}`;
            const edge = supportEdges.get(key) ?? { count: 0, direction: 0 };
            edge.count++;
            edge.direction += a < b ? 1 : -1;
            supportEdges.set(key, edge);
          }
        }
        expect(supportFaces).toBe(242);
        expect(supportVertices - supportEdges.size + supportFaces).toBe(2);
        for (const edge of supportEdges.values())
          expect(edge).toEqual({ count: 2, direction: 0 });
        const pending = [60],
          visited = new Set<number>(); // Shared ground cap.
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id)) continue;
          visited.add(id);
          for (const neighbor of adjacency[id])
            if (!visited.has(neighbor)) pending.push(neighbor);
        }
        expect(visited.size).toBe(position.count);
      });

      it("keeps ten exact supported flutter hinges on two staggered five-petal heads", () => {
        const geometry = createSprig(height),
          position = geometry.getAttribute("position");
        const petal = geometry.getAttribute("flowerPetal"),
          uv = geometry.getAttribute("uv");
        const fullHeight = geometry.getAttribute("flowerHeight").getY(0),
          index = geometry.getIndex()!;
        const groups = new Map<string, number[]>(),
          support = new Set<number>();
        const key = (i: number) => point(petal, i).toArray().join(",");
        for (let i = 0; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          if (ids.every((id) => petal.getW(id) === 0))
            ids.forEach((id) => support.add(id));
        }
        for (let i = 0; i < position.count; i++) {
          const weight = petal.getW(i);
          expect(weight).toBeGreaterThanOrEqual(0);
          expect(weight).toBeLessThanOrEqual(1);
          if (point(petal, i).lengthSq() === 0) {
            expect(weight).toBe(0);
            continue;
          }
          const ids = groups.get(key(i)) ?? [];
          ids.push(i);
          groups.set(key(i), ids);
          if (weight > 0) {
            expect(position.getY(i)).toBeGreaterThan(0);
            expect(
              Math.hypot(
                position.getX(i) - petal.getX(i),
                position.getZ(i) - petal.getZ(i),
              ),
            ).toBeLessThanOrEqual(0.08 * fullHeight);
          }
        }
        expect(groups.size).toBe(10);
        const headHeights = new Map<number, number>();
        for (const ids of groups.values()) {
          expect(ids).toHaveLength(22); // Shared hinge, four five-wide rows, tip.
          const hingeIds = ids.filter((id) => petal.getW(id) === 0);
          expect(hingeIds).toHaveLength(1);
          const hingeId = hingeIds[0],
            hinge = point(petal, hingeId);
          expect(point(position, hingeId).toArray()).toEqual(hinge.toArray());
          expect(support.has(hingeId)).toBe(true);
          headHeights.set(hinge.y, (headHeights.get(hinge.y) ?? 0) + 1);
          const tips = ids.filter((id) => petal.getW(id) === 1);
          expect(tips).toHaveLength(1);
          const mid = ids.filter((id) => uv.getY(id) === Math.fround(0.46));
          expect(mid).toHaveLength(5);
          const length = Math.hypot(
            position.getX(tips[0]) - hinge.x,
            position.getZ(tips[0]) - hinge.z,
          );
          const width = point(position, mid[0]).distanceTo(
            point(position, mid[4]),
          );
          expect(width / length).toBeGreaterThan(0.62);
          expect(
            (position.getY(mid[0]) + position.getY(mid[4])) / 2 -
              position.getY(mid[2]),
          ).toBeGreaterThan(height * 0.006);
        }
        expect(headHeights.size).toBe(2);
        expect([...headHeights.values()]).toEqual([5, 5]);
        const ys = [...headHeights.keys()];
        expect(Math.abs(ys[0] - ys[1])).toBeGreaterThan(height * 0.12);
        for (let i = 0; i < index.count; i += 3) {
          const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
          const flexed = ids.find((id) => petal.getW(id) > 0);
          if (flexed === undefined) continue;
          for (const id of ids) {
            expect(key(id)).toBe(key(flexed));
            if (petal.getW(id) === 0) {
              expect(point(position, id).toArray()).toEqual(
                point(petal, flexed).toArray(),
              );
              expect(support.has(id)).toBe(true);
            }
          }
        }
      });
    });
  }

  it("is deterministic, independently owned and proportional at the height limits", () => {
    const first = createSprig(0.75),
      second = createSprig(0.75);
    for (const name of Object.keys(first.attributes)) {
      expect(first.getAttribute(name).array).not.toBe(
        second.getAttribute(name).array,
      );
      expect(first.getAttribute(name).array).toEqual(
        second.getAttribute(name).array,
      );
    }
    expect(first.getIndex()!.array).not.toBe(second.getIndex()!.array);
    expect(first.getIndex()!.array).toEqual(second.getIndex()!.array);
    const small = createSprig(0.12),
      large = createSprig(0.8);
    expect(small.getIndex()!.array).toEqual(large.getIndex()!.array);
    for (const name of ["position", "flowerHeight", "flowerPetal"]) {
      const a = small.getAttribute(name).array,
        b = large.getAttribute(name).array;
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++)
        expect(b[i]).toBeCloseTo(
          a[i] * (name === "flowerPetal" && i % 4 === 3 ? 1 : 0.8 / 0.12),
          6,
        );
    }
    for (const name of ["uv", "color"])
      expect(small.getAttribute(name).array).toEqual(
        large.getAttribute(name).array,
      );
  });

  for (const variant of ["", "other", null, 0]) {
    it(`rejects unsupported variant ${String(variant)}`, () => {
      expect(() =>
        createRootedFlowerGeometry({ variant: variant as never }),
      ).toThrow(/variant/);
    });
  }
});
