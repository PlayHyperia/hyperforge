import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyVertexColors, mergeBufferGeometries } from "./geometry";
import { createWindowGeometry } from "./WindowGeometry";
import { createDoorFrameGeometry } from "./DoorTrimGeometry";

const owned = new Set<THREE.BufferGeometry>();
function keep<T extends THREE.BufferGeometry>(geometry: T): T {
  owned.add(geometry);
  return geometry;
}
afterEach(() => {
  for (const geometry of owned) geometry.dispose();
  owned.clear();
});
function box(x = 0) {
  const geometry = keep(new THREE.BoxGeometry(2, 3, 4));
  geometry.translate(x, 0, 0);
  applyVertexColors(geometry, new THREE.Color(0x8a6141));
  return geometry;
}
const attributes = ["position", "normal", "color", "uv", "uv2"] as const;
function expanded(geometry: THREE.BufferGeometry, name: string) {
  const attribute = geometry.getAttribute(name);
  const values: number[] = [];
  for (
    let corner = 0;
    corner < (geometry.index?.count ?? attribute.count);
    corner++
  ) {
    const index = geometry.index ? geometry.index.getX(corner) : corner;
    for (let component = 0; component < attribute.itemSize; component++)
      values.push(Math.fround(attribute.getComponent(index, component)));
  }
  return values;
}
function assertWinding(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute("position");
  const n = geometry.getAttribute("normal");
  const count = geometry.index?.count ?? p.count;
  for (let corner = 0; corner < count; corner += 3) {
    const indices = [0, 1, 2].map(
      (i) => geometry.index?.getX(corner + i) ?? corner + i,
    );
    const points = indices.map((i) =>
      new THREE.Vector3().fromBufferAttribute(p, i),
    );
    const face = points[1]
      .clone()
      .sub(points[0])
      .cross(points[2].clone().sub(points[0]));
    expect(face.lengthSq()).toBeGreaterThan(1e-14);
    face.normalize();
    for (const i of indices)
      expect(
        face.dot(new THREE.Vector3().fromBufferAttribute(n, i)),
      ).toBeGreaterThan(0.99999);
  }
}

describe("architectural merge: actual indexed topology and ownership", () => {
  it("expands every real BoxGeometry face and all attributes, not raw vertex triples", () => {
    const first = box(),
      second = box(5);
    expect(first.getAttribute("position").count).toBe(24);
    expect(first.index!.count).toBe(36);
    const native = keep(first.toNonIndexed());
    const merged = keep(mergeBufferGeometries([first, second], false));
    expect(merged.index).toBeNull();
    expect(merged.getAttribute("position").count).toBe(72);
    for (const name of attributes) {
      expect(expanded(first, name)).toEqual(
        Array.from(native.getAttribute(name).array),
      );
      expect(Array.from(merged.getAttribute(name).array)).toEqual([
        ...expanded(first, name),
        ...expanded(second, name),
      ]);
    }
    assertWinding(merged);
    // Executed probe56 / d0bca2bf3 helper concatenated raw positions and omitted
    // indices. This explicit reproduction is a corrupt historical comparator,
    // not an alternative generator or an expected output for the repaired path.
    const old = keep(new THREE.BufferGeometry());
    old.setAttribute("position", first.getAttribute("position").clone());
    old.setAttribute("normal", first.getAttribute("normal").clone());
    expect(old.getAttribute("position").count / 3).toBe(8);
    expect(expanded(old, "position")).not.toEqual(expanded(first, "position"));
    const oldNormals = old.getAttribute("normal");
    // The second raw triangle crosses the +X/-X face blocks.
    expect(
      new THREE.Vector3()
        .fromBufferAttribute(oldNormals, 3)
        .dot(new THREE.Vector3().fromBufferAttribute(oldNormals, 4)),
    ).toBe(-1);
  });

  it("preserves mixed and nested triangle lists without changing borrowed inputs", () => {
    const first = box(),
      second = keep(box(5).toNonIndexed()),
      third = box(10);
    const identity = first.index;
    const bytes = Array.from(first.getAttribute("position").array);
    const inner = keep(mergeBufferGeometries([first, second], false));
    const nested = keep(mergeBufferGeometries([inner, third], false));
    for (const name of attributes)
      expect(Array.from(nested.getAttribute(name).array)).toEqual([
        ...expanded(first, name),
        ...expanded(second, name),
        ...expanded(third, name),
      ]);
    expect(first.index).toBe(identity);
    expect(Array.from(first.getAttribute("position").array)).toEqual(bytes);
    assertWinding(nested);
  });

  it("supports interleaved and normalized CPU attributes through their native accessors", () => {
    const first = box(),
      second = box(5);
    const source = first.getAttribute("position");
    const data = new Float32Array(source.count * 4);
    for (let i = 0; i < source.count; i++)
      data.set([source.getX(i), source.getY(i), source.getZ(i), 99], i * 4);
    first.setAttribute(
      "position",
      new THREE.InterleavedBufferAttribute(
        new THREE.InterleavedBuffer(data, 4),
        3,
        0,
      ),
    );
    first.setAttribute(
      "color",
      new THREE.Uint8BufferAttribute(
        new Uint8Array(source.count * 3).fill(128),
        3,
        true,
      ),
    );
    const merged = keep(mergeBufferGeometries([first, second], false));
    for (const name of attributes)
      expect(Array.from(merged.getAttribute(name).array)).toEqual([
        ...expanded(first, name),
        ...expanded(second, name),
      ]);
  });

  it("generates missing flat normals from indexed winding without mutating either borrowed input", () => {
    const first = box();
    first.deleteAttribute("normal");
    const second = keep(new THREE.BufferGeometry());
    second.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3),
    );
    const originalAttributes = Object.keys(first.attributes);
    const merged = keep(mergeBufferGeometries([first, second], false));
    expect(Object.keys(first.attributes)).toEqual(originalAttributes);
    expect(first.getAttribute("normal")).toBeUndefined();
    expect(second.getAttribute("normal")).toBeUndefined();
    expect(first.boundingBox).toBeNull();
    expect(second.boundingBox).toBeNull();
    expect(merged.getAttribute("color")).toBeUndefined();
    assertWinding(merged);
    expect(merged.getAttribute("normal").getZ(36)).toBe(-1);
  });

  it("retains empty/singleton identity contracts and disposes duplicate owned inputs only once", () => {
    expect(Object.keys(keep(mergeBufferGeometries([])).attributes)).toEqual([]);
    const first = box();
    let disposed = 0;
    first.addEventListener("dispose", () => disposed++);
    expect(mergeBufferGeometries([first])).toBe(first);
    expect(disposed).toBe(0);
    const clone = keep(mergeBufferGeometries([first], false));
    expect(clone).not.toBe(first);
    expect(clone.index).not.toBe(first.index);
    expect(expanded(clone, "position")).toEqual(expanded(first, "position"));
    keep(mergeBufferGeometries([first, first]));
    owned.delete(first);
    expect(disposed).toBe(1);
  });

  it.each([
    "out-of-range",
    "negative",
    "fractional",
    "incomplete",
    "truncated",
    "nonfinite",
    "overflow",
    "missing-position",
  ])("rejects %s before disposing or mutating any source", (kind) => {
    const first = box(),
      bad = box(5);
    let disposals = 0;
    first.addEventListener("dispose", () => disposals++);
    bad.addEventListener("dispose", () => disposals++);
    if (kind === "out-of-range") bad.index!.setX(0, 24);
    if (kind === "negative")
      bad.setIndex(new THREE.Int16BufferAttribute([-1, 1, 2], 1));
    if (kind === "fractional")
      bad.setIndex(new THREE.Float32BufferAttribute([0.5, 1, 2], 1));
    if (kind === "incomplete") bad.setIndex([0, 1]);
    if (kind === "truncated")
      bad.setAttribute("uv2", new THREE.Float32BufferAttribute([0, 0], 2));
    if (kind === "nonfinite") bad.getAttribute("normal").setX(0, NaN);
    if (kind === "overflow")
      bad.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float64Array(72).fill(1e100), 3),
      );
    if (kind === "missing-position") bad.deleteAttribute("position");
    const originalNormal = first.getAttribute("normal");
    expect(() => mergeBufferGeometries([first, bad])).toThrow(
      /mergeBufferGeometries/,
    );
    expect(disposals).toBe(0);
    expect(first.getAttribute("normal")).toBe(originalNormal);
  });

  it("rejects excessive source counts without allocating large vertex buffers", () => {
    const empty = keep(new THREE.BufferGeometry());
    expect(() =>
      mergeBufferGeometries(Array.from({ length: 4097 }, () => empty)),
    ).toThrow(/Too many/);
    const oversized = keep(new THREE.BufferGeometry());
    const attribute = new THREE.Float32BufferAttribute([0, 0, 0], 3);
    attribute.count = 3_000_003;
    oversized.setAttribute("position", attribute);
    expect(() => mergeBufferGeometries([oversized, empty])).toThrow(
      /Invalid triangle count/,
    );
  });

  it.each([false, true])(
    "real window and nested door trim retain openings and planar winding (vertical=%s)",
    (isVertical) => {
      const window = createWindowGeometry({
        width: 1.2,
        height: 1.4,
        frameThickness: 0.04,
        frameDepth: 0.16,
        style: "crossbar-2x2",
        isVertical,
      });
      const door = createDoorFrameGeometry({
        width: 1.2,
        height: 2.2,
        frameWidth: 0.08,
        frameDepth: 0.16,
        style: "simple",
        isVertical,
        includeThreshold: false,
      });
      const frame = keep(window.frame!),
        mullions = keep(window.mullions!),
        doorFrame = keep(door.frame!);
      if (window.sill) keep(window.sill);
      expect(frame.getAttribute("position").count / 3).toBe(96);
      expect(mullions.getAttribute("position").count / 3).toBe(24);
      expect(doorFrame.getAttribute("position").count / 3).toBe(60);
      for (const geometry of [frame, mullions, doorFrame])
        assertWinding(geometry);
      const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      try {
        const ray = new THREE.Raycaster();
        const hit = (
          geometry: THREE.BufferGeometry,
          horizontal: number,
          y: number,
        ) => {
          ray.set(
            new THREE.Vector3(
              isVertical ? 1 : horizontal,
              y,
              isVertical ? horizontal : 1,
            ),
            new THREE.Vector3(isVertical ? -1 : 0, 0, isVertical ? 0 : -1),
          );
          return ray.intersectObject(new THREE.Mesh(geometry, material));
        };
        expect(hit(frame, 0, 0)).toHaveLength(0);
        expect(hit(frame, 0.59, 0).length).toBeGreaterThan(0);
        expect(hit(mullions, 0.2, 0.2)).toHaveLength(0);
        expect(hit(mullions, 0, 0.2).length).toBeGreaterThan(0);
        expect(hit(doorFrame, 0, 1.1)).toHaveLength(0);
        expect(hit(doorFrame, 0.64, 1.1).length).toBeGreaterThan(0);
        expect(hit(doorFrame, 0, 2.24).length).toBeGreaterThan(0);
      } finally {
        material.dispose();
      }
    },
  );

  it.each([0.28, 0.22])(
    "window callers transfer live results and dispose each internal source once (width=%s)",
    (width) => {
      // Observe the real method without replacing its behavior or creating a
      // geometry double. This catches the old duplicate and singleton disposal.
      const descriptor = Object.getOwnPropertyDescriptor(
        THREE.BufferGeometry.prototype,
        "dispose",
      )!;
      const original = THREE.BufferGeometry.prototype.dispose;
      const counts = new Map<THREE.BufferGeometry, number>();
      THREE.BufferGeometry.prototype.dispose = function () {
        counts.set(this, (counts.get(this) ?? 0) + 1);
        return original.call(this);
      };
      try {
        const result = createWindowGeometry({
          style: "leaded",
          width,
          height: 0.18,
        });
        if (width === 0.22) {
          // Exactly one lead box takes the helper's identity-preserving branch.
          expect(result.mullions!.index!.count).toBe(36);
        } else {
          expect(result.mullions!.index).toBeNull();
        }
        const outputs = [
          result.frame,
          result.mullions,
          result.sill,
          ...result.panes,
          ...result.shutters,
        ].filter((g): g is THREE.BufferGeometry => g !== null);
        for (const geometry of outputs) {
          expect(counts.get(geometry) ?? 0).toBe(0);
          geometry.dispose();
        }
        expect(counts.size).toBeGreaterThan(8);
        expect([...counts.values()].every((count) => count === 1)).toBe(true);
      } finally {
        Object.defineProperty(
          THREE.BufferGeometry.prototype,
          "dispose",
          descriptor,
        );
      }
    },
  );
});
