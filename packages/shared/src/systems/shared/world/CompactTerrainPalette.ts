/**
 * CPU grass-base approximation of compact PBR diffuse, not a lighting bake.
 * Linear means of the original 1024px RGB maps; the packing manifest and tests
 * reproduce these values. Texel detail stays on the GPU, ecology is unchanged.
 * Self-contained so GrassWorker embeds exactly this factory after bundling.
 */
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
        dirt: 1 - (1 - patch) * (1 - slopeDirt),
        cliff: math.smooth(composition.cliffStart, composition.cliffEnd, slope),
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
    }) {
      // Distortion noise only wears the path margin; it never changes meadow
      // or cliff classification. The same mean applies to both PBR projections.
      const { dirt, cliff, road, variation } = operations.weights(input);
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
          ) * variation,
      );
      return { r: result[0], g: result[1], b: result[2] };
    },
  };
  return operations;
}

export const COMPACT_TERRAIN_COMPOSITION = Object.freeze(
  createCompactTerrainColorOperations().getComposition(),
);
