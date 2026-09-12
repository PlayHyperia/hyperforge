import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import type { GrassSurfaceEligibility } from "../../../runtime/clientViewportMode";

/**
 * CPU grass-base approximation of compact PBR diffuse, not a lighting bake.
 * Linear means of the original 1024px RGB maps; the packing manifest and tests
 * reproduce these values. Texel detail stays on the GPU. Legacy ecology stays
 * unchanged; explicit compact decorative grass may opt into layer support.
 * Self-contained so GrassWorker embeds exactly this factory after bundling.
 */
export type CompactTerrainPond = Readonly<{
  id: string;
  centerX: number;
  centerZ: number;
  radius: number;
  surfaceY: number;
}>;

/** Detached colour-only view of the already admitted landform, not new terrain. */
export type CompactTerrainMacroField = Readonly<{
  centerX: number;
  centerZ: number;
  scale: number;
  ridgeBaseX: number;
  ridgeBend: number;
  ridgeStartZ: number;
  ridgeEndZ: number;
  ridgeEndFade: number;
  ridgeWestWidth: number;
  ridgeEastWidth: number;
  seaLevel: number;
  baseElevation: number;
  headlandDirectionX: number;
  headlandDirectionZ: number;
  headlandOuterCos: number;
  headlandInnerCos: number;
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
    // slope = 1 - abs(normal.y): roughly 22–40 degrees, not the former
    // 46–63 degree range that left the compact ridges covered in turf.
    cliffStart: 0.07,
    cliffEnd: 0.23,
    meadowDryStart: 0.28,
    meadowDryEnd: 0.72,
    meadowDryLow: 0.15,
    meadowDryHigh: 0.65,
    // Linear-reflectance multipliers, not sRGB values or baked illumination.
    // The pinned grass diffuse remains below 1 in every channel after tint.
    meadowDryRed: 1.12,
    meadowDryGreen: 0.96,
    meadowDryBlue: 1.1,
    macroShoulderStart: 0.25,
    macroShoulderEnd: 1.85,
    macroBoundaryNoise: 0.2,
    macroWestStart: -0.1,
    macroWestEnd: 0.65,
    macroRockSlopeStart: 0.015,
    macroRockSlopeEnd: 0.1,
    macroSoilStrength: 0.22,
    // Warm muted straw in LINEAR reflectance; no light or exposure multiplier.
    // This affects only grass within the admitted ridge shoulder, not soil.
    macroDryRed: 1.25,
    macroDryGreen: 0.95,
    macroDryBlue: 1.25,
    // Fractions of the admitted sea-to-interior rise, not absolute world Y.
    coastFadeStartLow: 0.5,
    coastFadeStartHigh: 0.65,
    coastFadeEndLow: 0.82,
    coastFadeEndHigh: 0.97,
    coastPatchStart: 0.35,
    coastPatchEnd: 0.65,
    coastEdgeNoise: 0.12,
    coastSoilLow: 0.35,
    coastSoilHigh: 0.9,
    coastHeadlandRock: 0.72,
    coastRidgeRock: 0.35,
    coastWetStart: -0.01,
    coastWetEndLow: 0.025,
    coastWetEndHigh: 0.055,
    coastWetAlbedo: 0.66,
    coastWetRoughness: 0.58,
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
    grass: [0.12687350988906373, 0.16117143469264922, 0.03425721790414253],
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
    grassEligibility(
      value: unknown,
      algorithm: string,
    ): GrassSurfaceEligibility {
      if (value === undefined || value === "legacy-biome-v1")
        return "legacy-biome-v1";
      if (
        value !== "compact-pbr-v1" ||
        (algorithm !== "compact-island-sculpt-v2" &&
          algorithm !== "compact-island-sculpt-v3")
      ) {
        throw new Error("Invalid compact grass surface eligibility");
      }
      return "compact-pbr-v1";
    },
    macroField(profile: WorldTerrainProfile): CompactTerrainMacroField | null {
      if (
        profile.algorithm !== "compact-island-sculpt-v2" &&
        profile.algorithm !== "compact-island-sculpt-v3"
      )
        return null;
      const ridge = profile.landform;
      if (!ridge) throw new Error("Macro surface requires admitted ridge");
      const field = {
        centerX: profile.island.centerX,
        centerZ: profile.island.centerZ,
        scale: 165 / profile.island.radius,
        ridgeBaseX: ridge.ridgeBaseX,
        ridgeBend: ridge.ridgeBend,
        ridgeStartZ: ridge.ridgeStartZ,
        ridgeEndZ: ridge.ridgeEndZ,
        ridgeEndFade: ridge.ridgeEndFade,
        ridgeWestWidth: ridge.ridgeWestWidth,
        ridgeEastWidth: ridge.ridgeEastWidth,
        seaLevel: profile.water.threshold,
        baseElevation: profile.height.baseOffset,
        headlandDirectionX: Math.cos(ridge.westHeadlandBearing),
        headlandDirectionZ: Math.sin(ridge.westHeadlandBearing),
        headlandOuterCos: Math.cos(ridge.westHeadlandHalfWidth),
        headlandInnerCos: Math.cos(ridge.westHeadlandHalfWidth * 0.5),
      };
      if (
        !Object.values(field).every(Number.isFinite) ||
        field.scale <= 0 ||
        field.ridgeEndZ <= field.ridgeStartZ ||
        field.ridgeEndFade <= 0 ||
        field.ridgeWestWidth <= 0 ||
        field.ridgeEastWidth <= 0 ||
        field.baseElevation <= field.seaLevel ||
        field.headlandInnerCos <= field.headlandOuterCos
      )
        throw new Error("Invalid admitted macro surface field");
      return Object.freeze(field);
    },
    macroWeights(
      x: number,
      z: number,
      noiseValue: number,
      field: CompactTerrainMacroField | null,
    ) {
      if (!field) return { dry: 0, westRock: 0 };
      const c = composition;
      const ax = (x - field.centerX) * field.scale;
      const az = (z - field.centerZ) * field.scale;
      const progress = Math.max(
        0,
        Math.min(
          1,
          (az - field.ridgeStartZ) / (field.ridgeEndZ - field.ridgeStartZ),
        ),
      );
      const cross =
        ax -
        (field.ridgeBaseX - field.ridgeBend * Math.sin(Math.PI * progress));
      const ends =
        math.smooth(
          field.ridgeStartZ,
          field.ridgeStartZ + field.ridgeEndFade,
          az,
        ) *
        (1 -
          math.smooth(
            field.ridgeEndZ - field.ridgeEndFade,
            field.ridgeEndZ,
            az,
          ));
      const west = -cross / field.ridgeWestWidth;
      const across = Math.max(cross / field.ridgeEastWidth, west);
      const shoulder =
        ends *
        (1 -
          math.smooth(
            c.macroShoulderStart,
            c.macroShoulderEnd,
            across + (noiseValue - 0.5) * c.macroBoundaryNoise,
          ));
      return {
        dry: shoulder,
        westRock:
          shoulder * math.smooth(c.macroWestStart, c.macroWestEnd, west),
      };
    },
    /** Redistribute existing rock only: grassSupport and its RNG stay unchanged. */
    coastWeights(input: {
      x: number;
      z: number;
      height: number;
      noiseValue: number;
      distortNoise: number;
      westRock: number;
      field: CompactTerrainMacroField | null;
    }) {
      const f = input.field;
      if (!f) return { soil: 0, wetness: 0 };
      const c = composition;
      const noise = Math.max(0, Math.min(1, input.noiseValue));
      const edge = Math.max(0, Math.min(1, input.distortNoise));
      const relative =
        (input.height - f.seaLevel) / (f.baseElevation - f.seaLevel);
      const coverage =
        1 -
        math.smooth(
          math.mix(c.coastFadeStartLow, c.coastFadeStartHigh, noise),
          math.mix(c.coastFadeEndLow, c.coastFadeEndHigh, noise),
          relative,
        );
      const dx = input.x - f.centerX,
        dz = input.z - f.centerZ;
      const direction =
        (dx * f.headlandDirectionX + dz * f.headlandDirectionZ) /
        Math.max(1e-6, Math.hypot(dx, dz));
      const headland = math.smooth(
        f.headlandOuterCos,
        f.headlandInnerCos,
        direction,
      );
      const patch = math.smooth(
        c.coastPatchStart,
        c.coastPatchEnd,
        noise + (edge - 0.5) * c.coastEdgeNoise,
      );
      return {
        soil:
          coverage *
          math.mix(c.coastSoilLow, c.coastSoilHigh, patch) *
          (1 - c.coastHeadlandRock * headland) *
          (1 - c.coastRidgeRock * Math.max(0, Math.min(1, input.westRock))),
        wetness:
          1 -
          math.smooth(
            c.coastWetStart,
            math.mix(c.coastWetEndLow, c.coastWetEndHigh, edge),
            relative,
          ),
      };
    },
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
    meadowTint(noiseValue: number, macroDry = 0) {
      const c = composition;
      const dryness = math.mix(
        c.meadowDryLow,
        c.meadowDryHigh,
        math.smooth(c.meadowDryStart, c.meadowDryEnd, noiseValue),
      );
      return [
        math.mix(math.mix(1, c.meadowDryRed, dryness), c.macroDryRed, macroDry),
        math.mix(
          math.mix(1, c.meadowDryGreen, dryness),
          c.macroDryGreen,
          macroDry,
        ),
        math.mix(
          math.mix(1, c.meadowDryBlue, dryness),
          c.macroDryBlue,
          macroDry,
        ),
      ];
    },
    weights(input: {
      noiseValue: number;
      slope: number;
      roadInfluence: number;
      distortNoise?: number;
      pondSurface?: { soil: number; wetness: number };
      macroSurface?: { dry: number; westRock: number };
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
          (1 - patch) *
            (1 - slopeDirt) *
            (1 -
              (input.macroSurface?.dry ?? 0) * composition.macroSoilStrength) *
            (1 - (input.pondSurface?.soil ?? 0)),
        cliff:
          Math.max(
            math.smooth(composition.cliffStart, composition.cliffEnd, slope),
            (input.macroSurface?.westRock ?? 0) *
              math.smooth(
                composition.macroRockSlopeStart,
                composition.macroRockSlopeEnd,
                slope,
              ),
          ) *
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
    /** Physical grass-layer support BEFORE road suppression by the generator. */
    grassSupport(input: {
      noiseValue: number;
      distortNoise: number;
      slope: number;
      surface: {
        x: number;
        z: number;
        height: number;
        pond: CompactTerrainPond | null;
        macroField?: CompactTerrainMacroField | null;
      };
    }) {
      const { dirt, cliff } = operations.weights({
        noiseValue: input.noiseValue,
        distortNoise: input.distortNoise,
        slope: input.slope,
        roadInfluence: 0,
        pondSurface: operations.pondWeights({
          ...input.surface,
          noiseValue: input.distortNoise,
        }),
        macroSurface: operations.macroWeights(
          input.surface.x,
          input.surface.z,
          input.noiseValue,
          input.surface.macroField ?? null,
        ),
      });
      return (1 - dirt) * (1 - cliff);
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
        macroField?: CompactTerrainMacroField | null;
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
      const macroSurface = input.surface
        ? operations.macroWeights(
            input.surface.x,
            input.surface.z,
            input.noiseValue,
            input.surface.macroField ?? null,
          )
        : { dry: 0, westRock: 0 };
      const { dirt, cliff, road, variation } = operations.weights({
        ...input,
        pondSurface,
        macroSurface,
      });
      const coast = input.surface
        ? operations.coastWeights({
            ...input.surface,
            noiseValue: input.noiseValue,
            distortNoise: input.distortNoise,
            westRock: macroSurface.westRock,
            field: input.surface.macroField ?? null,
          })
        : { soil: 0, wetness: 0 };
      const wetAlbedo = math.mix(
        1,
        composition.pondWetAlbedo,
        pondSurface.wetness,
      );
      // Tint only the grass diffuse before physical-layer blending. Full
      // paths and pond beds remain the original soil, not yellowed dirt.
      const meadowTint = operations.meadowTint(
        input.noiseValue,
        macroSurface.dry,
      );
      const result = palette.grass.map(
        (grass, channel) =>
          math.mix(
            math.mix(
              math.mix(
                grass * meadowTint[channel],
                palette.dirt[channel],
                dirt,
              ),
              math.mix(
                palette.rock[channel],
                palette.dirt[channel],
                coast.soil,
              ) * math.mix(1, composition.coastWetAlbedo, coast.wetness),
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
