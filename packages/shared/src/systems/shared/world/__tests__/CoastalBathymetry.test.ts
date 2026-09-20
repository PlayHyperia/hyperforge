import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  bakeCoastalBathymetry,
  COASTAL_BATHYMETRY,
  createCoastalBathymetryDomain,
  sampleCoastalBathymetry,
  type CanonicalGroundLease,
  type CoastalBounds,
} from "../CoastalBathymetry";
import { CoastalBathymetryOwner } from "../CoastalBathymetryOwner";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";

// Explicit analytic field fixtures test storage/lifecycle math, not a simulated
// game or a mocked renderer. Real TerrainSystem authority is tested separately.
function analyticField(
  bounds: CoastalBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
) {
  let revision = 0,
    alive = true,
    calls = 0,
    depth = 13.5;
  const profile = Object.freeze({
    ...COMPACT_WORLD_TERRAIN_PROFILE,
    bounds: Object.freeze({ ...bounds }),
    water: Object.freeze({ threshold: 16, oceanFloorHeight: 2.5 }),
  });
  const factory = (): CanonicalGroundLease => {
    const captured = revision;
    return Object.freeze({
      profile,
      revision: captured,
      supportBounds: [],
      isCurrent: () => alive && captured === revision,
      sampleHeight: (x: number, z: number) => {
        calls++;
        const outside =
          x < bounds.minX ||
          x > bounds.maxX ||
          z < bounds.minZ ||
          z > bounds.maxZ;
        return 16 - (outside ? depth : x === 0 && z === 0 ? -1 : depth);
      },
    });
  };
  return {
    factory,
    calls: () => calls,
    change: () => revision++,
    retire: () => {
      alive = false;
    },
    depth: (value: number) => {
      depth = value;
    },
  };
}

describe("signed coastal field storage and cooperative construction", () => {
  it("uses the actual compact 803-square lattice and exact half-texel phase", () => {
    const d = createCoastalBathymetryDomain(
      COMPACT_WORLD_TERRAIN_PROFILE.bounds,
    );
    expect(d).toMatchObject({
      width: 803,
      height: 803,
      firstX: 149.5,
      firstZ: 199.5,
      spacing: 0.5,
    });
    expect(d.width * d.height * 2).toBe(1_289_618);
    expect(((150 - d.firstX) / d.spacing + 0.5) / d.width).toBe(1.5 / 803);
    expect(Object.isFrozen(d.bounds)).toBe(true);
  });

  it("rejects nonfinite, fractional-step and oversized domains before allocation", () => {
    for (const bounds of [
      { minX: 0, maxX: Infinity, minZ: 0, maxZ: 1 },
      { minX: 0, maxX: 0, minZ: 0, maxZ: 1 },
      { minX: 0, maxX: 0.3, minZ: 0, maxZ: 1 },
      { minX: 0, maxX: 10_000, minZ: 0, maxZ: 10_000 },
    ])
      expect(() => createCoastalBathymetryDomain(bounds)).toThrow();
  });

  it("caps each texture axis even when a thin rectangle is below the total texel cap", () => {
    expect(COASTAL_BATHYMETRY.maxDimension).toBe(2048);
    const limit = createCoastalBathymetryDomain({
      minX: 0,
      maxX: 1022.5,
      minZ: 0,
      maxZ: 0.5,
    });
    expect(limit.width).toBe(2048);
    expect(limit.height).toBe(4);
    for (const bounds of [
      { minX: 0, maxX: 1023, minZ: 0, maxZ: 0.5 },
      { minX: 0, maxX: 0.5, minZ: 0, maxZ: 100_000 },
      { minX: 0, maxX: 100_000, minZ: 0, maxZ: 0.5 },
    ]) {
      const texels =
        ((bounds.maxX - bounds.minX) / 0.5 + 3) *
        ((bounds.maxZ - bounds.minZ) / 0.5 + 3);
      expect(texels).toBeLessThan(COASTAL_BATHYMETRY.maxTexels);
      expect(() => createCoastalBathymetryDomain(bounds)).toThrow(/dimensions/);
    }
  });

  it("rejects inexact GPU origins and half-metre centers despite finite double bounds", () => {
    // The gutter endpoints themselves are exact Float32, but their interior
    // half-step centers are not. Merely checking the two uniforms is insufficient.
    expect(Math.fround(8_388_608)).toBe(8_388_608);
    expect(Math.fround(8_388_610)).toBe(8_388_610);
    expect(Math.fround(8_388_608.5)).not.toBe(8_388_608.5);
    for (const bounds of [
      { minX: 8_388_608.5, maxX: 8_388_609.5, minZ: 0, maxZ: 1 },
      { minX: 0, maxX: 1, minZ: -8_388_609.5, maxZ: -8_388_608.5 },
      { minX: 1e16, maxX: 1e16 + 400, minZ: 0, maxZ: 1 },
      { minX: 0.1, maxX: 1.1, minZ: 0, maxZ: 1 },
    ])
      expect(() => createCoastalBathymetryDomain(bounds)).toThrow(/Float32/);
  });

  it("preserves every current center and admits exactly representable fractional/negative phases", () => {
    for (const bounds of [
      COMPACT_WORLD_TERRAIN_PROFILE.bounds,
      { minX: -1.25, maxX: 0.25, minZ: -0.25, maxZ: 1.25 },
    ]) {
      const d = createCoastalBathymetryDomain(bounds);
      for (const [origin, count] of [
        [d.firstX, d.width],
        [d.firstZ, d.height],
      ]) {
        for (let i = 0; i < count; i++) {
          const value = origin + i * d.spacing;
          expect(Math.fround(value)).toBe(value);
          if (i) expect(value - (origin + (i - 1) * d.spacing)).toBe(0.5);
        }
      }
    }
  });

  it("retains signed texels until bilinear interpolation and clamps outside to deep gutter", async () => {
    const source = analyticField();
    const field = await bakeCoastalBathymetry(
      source.factory(),
      new AbortController().signal,
    );
    expect(field).not.toBeNull();
    const f = field!;
    expect(f.data).toBeInstanceOf(Uint16Array);
    expect(f.statistics).toMatchObject({
      samples: 25,
      texelBytes: 50,
      gutterSamples: 16,
      gutterMin: 13.5,
      signedMin: -1,
    });
    expect(sampleCoastalBathymetry(f, 0, 0)).toBe(-1);
    expect(sampleCoastalBathymetry(f, 0.25, 0)).toBe(6.25);
    expect(sampleCoastalBathymetry(f, -100, 100)).toBe(13.5);
    expect(() => sampleCoastalBathymetry(f, NaN, 0)).toThrow();
    expect(source.calls()).toBe(25);
  });

  it.each([NaN, Infinity, 65505, -65505, 7.99])(
    "rejects invalid encoded field/gutter depth %s",
    async (value) => {
      const source = analyticField();
      source.depth(value);
      await expect(
        bakeCoastalBathymetry(source.factory(), new AbortController().signal),
      ).rejects.toThrow();
    },
  );

  it("does not allocate/sample already cancelled or stale work", async () => {
    const source = analyticField(),
      controller = new AbortController();
    controller.abort();
    expect(
      await bakeCoastalBathymetry(source.factory(), controller.signal),
    ).toBeNull();
    const lease = source.factory();
    source.change();
    expect(
      await bakeCoastalBathymetry(lease, new AbortController().signal),
    ).toBeNull();
    expect(source.calls()).toBe(0);
  });

  it("rejects authored grading outside the finite domain before sampling", async () => {
    const source = analyticField();
    const lease = {
      ...source.factory(),
      supportBounds: [{ minX: -1, maxX: 1, minZ: 0, maxZ: 1 }],
    };
    await expect(
      bakeCoastalBathymetry(lease, new AbortController().signal),
    ).rejects.toThrow(/grading/);
    expect(source.calls()).toBe(0);
  });

  it("cancels superseded slices without publishing partial arrays", async () => {
    const source = analyticField({ minX: 0, maxX: 20, minZ: 0, maxZ: 20 });
    const controller = new AbortController();
    let batches = 0;
    const field = await bakeCoastalBathymetry(
      source.factory(),
      controller.signal,
      () => {
        batches++;
        globalThis.queueMicrotask(() => controller.abort());
      },
    );
    expect(field).toBeNull();
    expect(batches).toBe(1);
    expect(source.calls()).toBeGreaterThan(0);
    expect(source.calls()).toBeLessThanOrEqual(512);
  });

  it("lets a real timer revoke authority between slices without publishing", async () => {
    const source = analyticField({ minX: 0, maxX: 40, minZ: 0, maxZ: 40 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let batches = 0;
    try {
      const field = await bakeCoastalBathymetry(
        source.factory(),
        new AbortController().signal,
        () => {
          if (++batches === 1) timer = setTimeout(source.retire, 0);
        },
      );
      expect(field).toBeNull();
      expect(source.calls()).toBeGreaterThan(0);
      expect(source.calls()).toBeLessThan(83 * 83);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });

  it("checks authority again after the last progress callback", async () => {
    const source = analyticField();
    expect(
      await bakeCoastalBathymetry(
        source.factory(),
        new AbortController().signal,
        source.change,
      ),
    ).toBeNull();
    expect(source.calls()).toBe(25);
  });
});

describe("actual Three coastal texture ownership", () => {
  it("publishes a complete linear R16F revision, replacing the shared base node once", async () => {
    const source = analyticField(),
      owner = new CoastalBathymetryOwner();
    const first = owner.getTexture(),
      sample = owner.signedDepth;
    let retired = 0;
    first.addEventListener("dispose", () => retired++);
    try {
      expect(owner.getReadiness()).toMatchObject({
        required: false,
        ready: true,
        status: "inactive",
      });
      expect(await owner.configure(source.factory)).toBe(true);
      const value = owner.getTexture();
      expect(value).not.toBe(first);
      expect(retired).toBe(1);
      expect(owner.textureNode.value).toBe(value);
      expect(owner.signedDepth).toBe(sample);
      expect(value.image).toMatchObject({ width: 5, height: 5 });
      expect(value.format).toBe(THREE.RedFormat);
      expect(value.type).toBe(THREE.HalfFloatType);
      expect(value.colorSpace).toBe(THREE.NoColorSpace);
      expect(value.minFilter).toBe(THREE.LinearFilter);
      expect(value.magFilter).toBe(THREE.LinearFilter);
      expect(value.wrapS).toBe(THREE.ClampToEdgeWrapping);
      expect(value.wrapT).toBe(THREE.ClampToEdgeWrapping);
      expect(value.generateMipmaps).toBe(false);
      expect(value.flipY).toBe(false);
      expect(value.unpackAlignment).toBe(1);
      expect(owner.getReadiness()).toMatchObject({
        required: true,
        ready: true,
        sourceRevision: 0,
      });
      expect(owner.enabled.value).toBe(1);
      expect(owner.seaLevel.value).toBe(16);
      const calls = source.calls();
      for (let i = 0; i < 100; i++) owner.update();
      expect(source.calls()).toBe(calls);
    } finally {
      owner.destroy();
    }
  });

  it("disables stale optics immediately and publishes only a complete replacement", async () => {
    const source = analyticField(),
      owner = new CoastalBathymetryOwner();
    try {
      await owner.configure(source.factory);
      const original = owner.getTexture();
      source.change();
      owner.invalidate();
      expect(owner.enabled.value).toBe(0);
      expect(owner.getReadiness().ready).toBe(false);
      owner.update();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(owner.getReadiness()).toMatchObject({
        ready: true,
        sourceRevision: 1,
      });
      expect(owner.getTexture()).not.toBe(original);
    } finally {
      owner.destroy();
    }
  });

  it("does not retry an invalid current source on every frame", async () => {
    const source = analyticField(),
      owner = new CoastalBathymetryOwner();
    source.depth(7);
    try {
      await expect(owner.configure(source.factory)).rejects.toThrow(/gutter/);
      const calls = source.calls();
      for (let i = 0; i < 100; i++) owner.update();
      expect(source.calls()).toBe(calls);
      expect(owner.getReadiness()).toMatchObject({
        ready: false,
        status: "failed",
      });
      source.depth(13.5);
      source.change();
      owner.invalidate();
      owner.update();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(owner.getReadiness().ready).toBe(true);
    } finally {
      owner.destroy();
    }
  });

  it("retains no published texture from destruction during a real cooperative yield", async () => {
    const source = analyticField({ minX: 0, maxX: 20, minZ: 0, maxZ: 20 });
    const owner = new CoastalBathymetryOwner(),
      first = owner.getTexture();
    let retired = 0;
    first.addEventListener("dispose", () => retired++);
    const task = owner.configure(source.factory);
    owner.destroy();
    owner.destroy();
    expect(await task).toBe(false);
    expect(retired).toBe(1);
    expect(owner.enabled.value).toBe(0);
    expect(owner.getReadiness().status).toBe("destroyed");
    await expect(owner.configure(source.factory)).rejects.toThrow(/destroyed/);
  });

  it("serializes superseding configuration and never lets old completion replace the new field", async () => {
    const source = analyticField({ minX: 0, maxX: 20, minZ: 0, maxZ: 20 });
    const owner = new CoastalBathymetryOwner();
    try {
      const old = owner.configure(source.factory);
      source.change();
      const next = owner.configure(source.factory);
      expect(await old).toBe(false);
      expect(await next).toBe(true);
      expect(owner.getReadiness()).toMatchObject({
        ready: true,
        sourceRevision: 1,
      });
    } finally {
      owner.destroy();
    }
  });

  it("handles a synchronous retirement listener without reporting a live publication", async () => {
    const source = analyticField(),
      owner = new CoastalBathymetryOwner();
    owner.getTexture().addEventListener("dispose", () => owner.destroy());
    expect(await owner.configure(source.factory)).toBe(false);
    expect(owner.getReadiness().ready).toBe(false);
    expect(owner.enabled.value).toBe(0);
  });
});
