import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import THREE, { reflector } from "../../../../extras/three/three";
import { createTreeDissolveMaterial } from "../GPUMaterials";
import {
  AMBIENT_LIGHT,
  DAY_CYCLE,
  EXPOSURE,
  FOG_COLORS,
  HEMISPHERE_LIGHT,
  NIGHT,
  SUN_LIGHT,
  SUN_SHADE,
} from "../LightingConfig";
import { createTerrainMaterial, TERRAIN_SHADE } from "../TerrainShader";
import { WaterSystem } from "../WaterSystem";

// Real Three colors and actual material factories, without a renderer or GPU.
// Palette Y conservation does not assert unchanged colored-surface luminance,
// GPU compilation, pixel quality, or final day/night art acceptance.
type RGB = readonly [number, number, number];
const luminance = (rgb: RGB) =>
  0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const rows: ReadonlyArray<{ name: string; original: RGB; current: RGB }> = [
  { name: "moon", original: [0.05, 0.5, 0.7], current: SUN_LIGHT.MOON_COLOR },
  {
    name: "ambient night",
    original: [0.05, 0.35, 0.5],
    current: AMBIENT_LIGHT.NIGHT_COLOR,
  },
  {
    name: "hemisphere night sky",
    original: [0, 0.15, 0.3],
    current: HEMISPHERE_LIGHT.NIGHT_SKY_COLOR,
  },
  {
    name: "hemisphere night ground",
    original: [0.02, 0.05, 0.1],
    current: HEMISPHERE_LIGHT.NIGHT_GROUND_COLOR,
  },
  {
    name: "shared shade",
    original: [0, 0.5, 0.7],
    current: SUN_SHADE.TINT_COLOR,
  },
];

describe("luminance-preserving lighting chromaticity candidate", () => {
  it.each(rows)("preserves linear Y and reduces $name chroma by 75%", (row) => {
    const oldY = luminance(row.original);
    const color = new THREE.Color(...row.current);
    expect(color.toArray()).toEqual([...row.current]); // No sRGB decode.
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(row.current[i])).toBe(true);
      expect(row.current[i]).toBeGreaterThan(0);
      expect(row.current[i]).toBeLessThanOrEqual(1);
      expect(row.current[i]).toBeCloseTo(
        row.original[i] * 0.25 + oldY * 0.75,
        14,
      );
    }
    expect(luminance(row.current)).toBeCloseTo(oldY, 14);
    expect(Math.max(...row.current) - Math.min(...row.current)).toBeCloseTo(
      (Math.max(...row.original) - Math.min(...row.original)) * 0.25,
      14,
    );
  });

  it("retains phase, intensity, exposure, day palettes and fog contracts", () => {
    expect(DAY_CYCLE).toEqual({
      DURATION_SEC: 240,
      DAWN_START: 0.22,
      DAWN_MID: 0.25,
      DAWN_END: 0.28,
      DUSK_START: 0.72,
      DUSK_MID: 0.75,
      DUSK_END: 0.78,
      NOON_MIN_INTENSITY: 0.85,
    });
    expect(EXPOSURE).toEqual({ DAY: 0.85, NIGHT: 1.1, LERP_SPEED: 0.03 });
    expect(FOG_COLORS).toEqual({ DAY: 0xd4c8b8, NIGHT: 0x2b3445 });
    expect(NIGHT.BRIGHTNESS).toBe(0.8);
    expect(SUN_LIGHT.DAY_INTENSITY_MULTIPLIER).toBe(1.8);
    expect(SUN_LIGHT.MOON_INTENSITY_MULTIPLIER).toBe(0.35);
    expect(SUN_LIGHT.DAY_COLOR).toEqual([1, 0.98, 0.92]);
    expect(SUN_LIGHT.GOLDEN_HOUR_COLOR).toEqual([1, 0.85, 0.6]);
    expect(SUN_LIGHT.GOLDEN_HOUR_RANGES).toEqual([
      [0.22, 0.32],
      [0.68, 0.78],
    ]);
    expect(SUN_LIGHT.DEFAULT_DIRECTION).toEqual([0.5, 0.8, 0.3]);
    expect(SUN_LIGHT.TILT).toBe(0.3);
    expect(SUN_LIGHT.DIRECTION_LERP).toBe(0.02);
    expect(AMBIENT_LIGHT.DAY_COLOR).toEqual([1, 0.95, 0.95]);
    expect(AMBIENT_LIGHT.INTENSITY_BASE).toBe(0.8);
    expect(AMBIENT_LIGHT.INTENSITY_DAY_ADD).toBe(0.5 - 0.8);
    expect(HEMISPHERE_LIGHT.DAY_SKY_COLOR).toEqual([0.53, 0.81, 0.92]);
    expect(HEMISPHERE_LIGHT.DAY_GROUND_COLOR).toEqual([0.36, 0.27, 0.18]);
    expect(HEMISPHERE_LIGHT.INTENSITY_BASE).toBe(0.8);
    expect(HEMISPHERE_LIGHT.INTENSITY_DAY_ADD).toBe(0.9 - 0.8);
    expect(SUN_SHADE.STRENGTH).toBe(1);
    expect(TERRAIN_SHADE.STRENGTH).toBe(0.7);
  });

  it.each([
    { name: "ambient", row: rows[1], day: AMBIENT_LIGHT.DAY_COLOR, total: 0.5 },
    {
      name: "sky fill",
      row: rows[2],
      day: HEMISPHERE_LIGHT.DAY_SKY_COLOR,
      total: 0.9,
    },
    {
      name: "ground fill",
      row: rows[3],
      day: HEMISPHERE_LIGHT.DAY_GROUND_COLOR,
      total: 0.9,
    },
  ])(
    "retains $name interpolated light Y across the cycle",
    ({ row, day, total }) => {
      const target = new THREE.Color(...day);
      for (let i = 0; i <= 100; i++) {
        const d = i / 100;
        const intensity = 0.8 + d * (total - 0.8);
        const old = new THREE.Color(...row.original).lerp(target, d);
        const current = new THREE.Color(...row.current).lerp(target, d);
        const oldY = luminance([old.r, old.g, old.b]) * intensity;
        expect(
          luminance([current.r, current.g, current.b]) * intensity,
        ).toBeCloseTo(oldY, 14);
      }
    },
  );

  it("publishes the calibrated default through the actual terrain/grass shade owner", () => {
    const first = createTerrainMaterial();
    const second = createTerrainMaterial();
    try {
      expect(first.terrainUniforms.shade.tint.value.toArray()).toEqual([
        ...SUN_SHADE.TINT_COLOR,
      ]);
      expect(first.terrainUniforms.shade).not.toBe(
        second.terrainUniforms.shade,
      );
      expect(first.terrainUniforms.shade.strength.value).toBe(0.7);
      expect(first.colorNode).toBeInstanceOf(THREE.Node);
      expect(first.outputNode).toBeInstanceOf(THREE.Node);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("publishes the calibrated default through the actual tree factory without repainting", () => {
    const map = new THREE.DataTexture(
      new Uint8Array([128, 192, 64, 255]),
      1,
      1,
    );
    const source = new THREE.MeshStandardMaterial({ map, vertexColors: true });
    const original = source.toJSON();
    const tree = createTreeDissolveMaterial(source);
    try {
      expect(tree.treeUniforms.shadeColor.value.toArray()).toEqual([
        ...SUN_SHADE.TINT_COLOR,
      ]);
      expect(tree.treeUniforms.illumination.blend.value).toBe(0);
      expect(tree.map).toBe(map);
      expect(source.toJSON()).toEqual(original);
      expect(tree.outputNode).toBeInstanceOf(THREE.Node);
    } finally {
      tree.dispose();
      source.dispose();
      map.dispose();
    }
  });

  it("publishes the calibrated default through both actual water material factories", () => {
    const world = new World();
    const system = new WaterSystem(world);
    // Supply real CPU textures and a real, uninitialized reflection node. No
    // renderer, request, render target allocation or framebuffer copy occurs.
    const reflection = reflector();
    Reflect.set(system, "reflection", reflection);
    for (const key of ["normalTex", "flowTex", "foamTex"]) {
      Reflect.set(
        system,
        key,
        new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1),
      );
    }
    try {
      for (const type of ["lake", "ocean"] as const) {
        const factory: unknown = Reflect.get(
          system,
          type === "lake" ? "createLakeMaterial" : "createOceanMaterial",
        );
        if (typeof factory !== "function")
          throw new Error("Missing water factory");
        const material: unknown = factory.call(system);
        if (!(material instanceof THREE.Material))
          throw new Error("Invalid material");
        Reflect.set(
          system,
          type === "lake" ? "lakeMaterial" : "oceanMaterial",
          material,
        );
        const row = system.waterUniformsByType[type];
        if (!row) throw new Error("Missing actual water uniforms");
        expect(row.shadeColor.value.toArray()).toEqual([
          ...SUN_SHADE.TINT_COLOR,
        ]);
        expect(row.illumination.blend.value).toBe(0);
      }
      expect(system.waterUniformsByType.lake?.shadeColor).not.toBe(
        system.waterUniformsByType.ocean?.shadeColor,
      );
    } finally {
      system.destroy();
      reflection.reflector.dispose();
      world.destroy();
    }
  });
});
