import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import { computeBaseHeight, computeIslandMask } from "../TerrainHeightParams";
import {
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE as sculpted,
  COMPACT_WORLD_TERRAIN_PROFILE as blockout,
  deserializeWorldTerrainProfile,
  resolveWorldTerrainProfile,
  serializeWorldTerrainProfile,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

const landform = createCompactIslandLandform();
const noise = new NoiseGenerator(sculpted.seed);
const height = (x: number, z: number) => landform.height(x, z, noise, sculpted);

describe("authored compact island landform", () => {
  it("requires an explicit distinct admitted algorithm and identity", () => {
    expect(sculpted.algorithm).toBe("compact-island-sculpt-v1");
    expect(sculpted.id).toBe("compact-duel-island-v2");
    expect(resolveWorldTerrainProfile(sculpted)).toEqual(sculpted);
    expect(
      deserializeWorldTerrainProfile(serializeWorldTerrainProfile(sculpted)),
    ).toEqual(sculpted);
    expect(worldTerrainProfileIdentity(sculpted)).not.toBe(
      worldTerrainProfileIdentity(blockout),
    );
    expect(() =>
      validateWorldTerrainProfile({ ...sculpted, algorithm: "unknown-sculpt" }),
    ).toThrow();
    expect(() =>
      validateWorldTerrainProfile({ ...sculpted, kind: "large-world" }),
    ).toThrow();
    expect(Object.isFrozen(sculpted.height)).toBe(true);
  });

  it("uses the same landform for main-thread height and island mask without biome-dependent cliffs", () => {
    for (let x = 150; x <= 550; x += 8) {
      for (let z = 200; z <= 600; z += 8) {
        const y = height(x, z);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(sculpted.water.oceanFloorHeight);
        expect(y).toBeLessThan(45);
        for (const weights of [
          { forest: 1 },
          { canyon: 1 },
          { tundra: 1 },
          {},
        ]) {
          expect(computeBaseHeight(x, z, noise, {}, weights, sculpted)).toBe(y);
        }
        expect(computeIslandMask(x, z, noise, sculpted)).toBe(
          landform.mask(x, z, noise, sculpted),
        );
      }
    }
  });

  it("keeps the working meadow near the authored grade with relief beside the campus", () => {
    for (const [x, z] of [
      [350, 320],
      [343, 302],
      [368, 419],
      [385, 374],
    ]) {
      expect(height(x, z)).toBeGreaterThan(26);
      expect(height(x, z)).toBeLessThan(31);
    }
    // Western landmark ridge is intentionally not centered under arena floors.
    expect(height(253, 403)).toBeGreaterThan(height(368, 419) + 8);
    for (let x = 320; x <= 410; x += 5) {
      for (let z = 350; z <= 485; z += 5) {
        expect(Math.abs(height(x, z) - 28.419301523097687)).toBeLessThan(5);
      }
    }
  });

  it("reaches a continuous seabed on all coastline bearings without a zero-height step", () => {
    for (let angle = 0; angle < 128; angle++) {
      const theta = (angle * Math.PI) / 64;
      const at = (r: number) =>
        [350 + Math.cos(theta) * r, 400 + Math.sin(theta) * r] as const;
      let inside = 100;
      let outside = 190;
      for (let i = 0; i < 48; i++) {
        const middle = (inside + outside) / 2;
        const [x, z] = at(middle);
        if (landform.mask(x, z, noise, sculpted) === 0) outside = middle;
        else inside = middle;
      }
      expect(height(...at(outside + 0.0001))).toBe(
        sculpted.water.oceanFloorHeight,
      );
      expect(
        Math.abs(
          height(...at(inside - 0.0001)) - sculpted.water.oceanFloorHeight,
        ),
      ).toBeLessThan(1e-7);
      expect(height(...at(inside - 1))).toBeGreaterThan(
        sculpted.water.oceanFloorHeight,
      );
    }
  });

  it("has no angular seam and translates the complete authoring shape with its profile", () => {
    const translated = validateWorldTerrainProfile({
      ...sculpted,
      id: "translated-sculpt-test",
      bounds: { minX: 1150, maxX: 1550, minZ: -800, maxZ: -400 },
      island: { ...sculpted.island, centerX: 1350, centerZ: -600 },
    });
    for (let r = 0; r <= 200; r += 2) {
      expect(height(350 - r, 400 - 1e-7)).toBeCloseTo(
        height(350 - r, 400 + 1e-7),
        5,
      );
      expect(
        landform.height(350 + r + 1000, 360 - 1000, noise, translated),
      ).toBeCloseTo(height(350 + r, 360), 10);
    }
  });

  it("is deterministic but responds to explicit seeded detail", () => {
    const otherNoise = new NoiseGenerator(41);
    const other = validateWorldTerrainProfile({ ...sculpted, seed: 41 });
    let differences = 0;
    for (let x = 250; x <= 450; x += 10) {
      const baseline = height(x, 330);
      expect(
        landform.height(x, 330, new NoiseGenerator(sculpted.seed), sculpted),
      ).toBe(baseline);
      if (
        Math.abs(landform.height(x, 330, otherNoise, other) - baseline) > 0.01
      )
        differences++;
    }
    expect(differences).toBeGreaterThan(10);
  });

  it("keeps embedded factory source self-contained after minification and keepNames", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../CompactIslandLandform.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "iife",
      globalName: "CompactLandformBundle",
      keepNames: true,
      minify: true,
    });
    const source = runInNewContext(
      `${result.outputFiles[0].text}\nCompactLandformBundle.buildCompactIslandLandformJS()`,
    ) as string;
    // Fresh realm: no bundler's function-name helper is made available.
    const embedded = runInNewContext(source) as ReturnType<
      typeof createCompactIslandLandform
    >;
    for (let x = 150; x <= 550; x += 11) {
      for (let z = 200; z <= 600; z += 11) {
        expect(embedded.height(x, z, noise, sculpted)).toBe(height(x, z));
        expect(embedded.mask(x, z, noise, sculpted)).toBe(
          landform.mask(x, z, noise, sculpted),
        );
      }
    }
  });
});
