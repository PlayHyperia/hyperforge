/**
 * CPU grass-base approximation of compact PBR diffuse, not a lighting bake.
 * Linear means of the original 1024px RGB maps; the packing manifest and tests
 * reproduce these values. Texel detail stays on the GPU, ecology is unchanged.
 * Self-contained so GrassWorker embeds exactly this factory after bundling.
 */
export type CompactTerrainPond = Readonly<{
  id: string;
  centerX: number;
  centerZ: number;
  radius: number;
  surfaceY: number;
}>;

export function createCompactTerrainColorOperations() {
  const composition = {
    patchStart: 0.5,
    patchEnd: 0.72,
    patchStrength: 0.12,
    flatStart: 0.3,
    flatEnd: 0.05,
    slopeDirtStart: 0.15,
    slopeDirtPeak: 0.4,
    slopeDirtEnd: 0.6,
    slopeDirtFall: 0.3,
    slopeDirtStrength: 0.2,
    cliffStart: 0.3,
    cliffEnd: 0.55,
    variationLow: 0.98,
    variationHigh: 1.02,
    pathEdgeNoiseContrast: 2.5,
    pathEdgeStartLow: 0.04,
    pathEdgeStartHigh: 0.26,
    pathEdgeEndLow: 0.74,
    pathEdgeEndHigh: 0.96,
    pondBankReach: 3,
    pondRadialFade: 0.75,
    pondSoilFullHeight: 0,
    pondSoilEndHeight: 0.22,
    pondBankNoiseHeight: 0.06,
    pondWetFullHeight: 0.02,
    pondWetEndHeight: 0.18,
    pondWetAlbedo: 0.72,
    pondWetRoughness: 0.62,
  };
  const palette = {
    grass: [0.033681753576253116, 0.14414087466070133, 0.013722332612374167],
    dirt: [0.13570346695867627, 0.10530763563352, 0.06788700038018664],
    rock: [0.23471111495321656, 0.21598528801526068, 0.17766932960947915],
  };
  const math = {
    smooth(a: number, b: number, value: number) {
      const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    mix(a: number, b: number, weight: number) {
      return a + (b - a) * weight;
    },
  };
  const operations = {
    validatePond(value: CompactTerrainPond | null): CompactTerrainPond | null {
      if (value === null) return null;
      if (
        !value ||
        typeof value.id !== "string" ||
        !value.id.length ||
        ![value.centerX, value.centerZ, value.radius, value.surfaceY].every(
          Number.isFinite,
        ) ||
        value.radius <= 0 ||
        value.radius > 128
      )
        throw new Error("Invalid admitted compact terrain pond");
      return Object.freeze({
        id: value.id,
        centerX: value.centerX,
        centerZ: value.centerZ,
        radius: value.radius,
        surfaceY: value.surfaceY,
      });
    },
    pondWeights(input: {
      x: number;
      z: number;
      height: number;
      noiseValue: number;
      pond: CompactTerrainPond | null;
    }) {
      if (!input.pond) return { soil: 0, wetness: 0 };
      const p = input.pond,
        c = composition;
      const distance = Math.hypot(input.x - p.centerX, input.z - p.centerZ);
      const region =
        1 -
        math.smooth(
          p.radius + c.pondBankReach - c.pondRadialFade,
          p.radius + c.pondBankReach,
          distance,
        );
      const relativeHeight = input.height - p.surfaceY;
      const noiseHeight = (input.noiseValue - 0.5) * 2 * c.pondBankNoiseHeight;
      return {
        soil:
          region *
          (1 -
            math.smooth(
              c.pondSoilFullHeight + noiseHeight,
              c.pondSoilEndHeight + noiseHeight,
              relativeHeight,
            )),
        wetness:
          region *
          (1 -
            math.smooth(
              c.pondWetFullHeight,
              c.pondWetEndHeight,
              relativeHeight,
            )),
      };
    },
    getComposition() {
      return { ...composition };
    },
    getPalette() {
      return {
        grass: [...palette.grass],
        dirt: [...palette.dirt],
        rock: [...palette.rock],
      };
    },
    weights(input: {
      noiseValue: number;
      slope: number;
      roadInfluence: number;
      distortNoise?: number;
      pondSurface?: { soil: number; wetness: number };
    }) {
      // Meadow dirt is restrained; steep rock follows actual geometric slope,
      // never the legacy high-frequency distorted normal classification.
      const slope = Math.max(0, Math.min(1, input.slope));
      const patch =
        math.smooth(
          composition.patchStart,
          composition.patchEnd,
          input.noiseValue,
        ) *
        math.smooth(composition.flatStart, composition.flatEnd, slope) *
        composition.patchStrength;
      const slopeDirt =
        math.smooth(
          composition.slopeDirtStart,
          composition.slopeDirtPeak,
          slope,
        ) *
        math.smooth(
          composition.slopeDirtEnd,
          composition.slopeDirtFall,
          slope,
        ) *
        composition.slopeDirtStrength;
      const edgeNoise = Math.max(
        0,
        Math.min(
          1,
          ((input.distortNoise ?? 0.5) - 0.5) *
            composition.pathEdgeNoiseContrast +
            0.5,
        ),
      );
      return {
        dirt:
          1 -
          (1 - patch) * (1 - slopeDirt) * (1 - (input.pondSurface?.soil ?? 0)),
        cliff:
          math.smooth(composition.cliffStart, composition.cliffEnd, slope) *
          (1 - (input.pondSurface?.soil ?? 0)),
        road: math.smooth(
          math.mix(
            composition.pathEdgeStartLow,
            composition.pathEdgeStartHigh,
            edgeNoise,
          ),
          math.mix(
            composition.pathEdgeEndLow,
            composition.pathEdgeEndHigh,
            edgeNoise,
          ),
          input.roadInfluence,
        ),
        variation: math.mix(
          composition.variationLow,
          composition.variationHigh,
          input.noiseValue,
        ),
      };
    },
    /**
     * sampleNoiseCPU(x,z,0.0008) and geometric
     * slope=1-abs(normal.y). roadInfluence is RAW mask/canonical path influence;
     * the same final smoothstep as TerrainShader is applied here exactly once.
     */
    sample(input: {
      noiseValue: number;
      distortNoise: number;
      slope: number;
      roadInfluence: number;
      surface?: {
        x: number;
        z: number;
        height: number;
        pond: CompactTerrainPond | null;
      };
    }) {
      // Distortion noise wears path and pond margins, not meadow or cliff
      // classification. The same mean applies to both PBR projections.
      const pondSurface = input.surface
        ? operations.pondWeights({
            ...input.surface,
            noiseValue: input.distortNoise,
          })
        : { soil: 0, wetness: 0 };
      const { dirt, cliff, road, variation } = operations.weights({
        ...input,
        pondSurface,
      });
      const wetAlbedo = math.mix(
        1,
        composition.pondWetAlbedo,
        pondSurface.wetness,
      );
      const result = palette.grass.map(
        (grass, channel) =>
          math.mix(
            math.mix(
              math.mix(grass, palette.dirt[channel], dirt),
              palette.rock[channel],
              cliff,
            ),
            palette.dirt[channel],
            road,
          ) *
          variation *
          wetAlbedo,
      );
      return { r: result[0], g: result[1], b: result[2] };
    },
  };
  return operations;
}

export const COMPACT_TERRAIN_COMPOSITION = Object.freeze(
  createCompactTerrainColorOperations().getComposition(),
);
