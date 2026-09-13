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

/** Colour-only planting footprint; admission owns placement and count limits. */
export type CompactTerrainPlantingLobe = Readonly<{
  centerX: number;
  centerZ: number;
  radiusX: number;
  radiusZ: number;
}>;

/** World-space surface authoring, never a terrain-height or vegetation mask. */
export type CompactTerrainGroundRibbon = Readonly<{
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  coreRadius: number;
  outerRadius: number;
  strength: number;
}>;
export type CompactTerrainHavenGround = Readonly<{
  talus: readonly CompactTerrainGroundRibbon[];
  wear: readonly CompactTerrainGroundRibbon[];
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
  havenGround?: CompactTerrainHavenGround;
}>;

export function createCompactTerrainColorOperations() {
  const composition = {
    // Fresh/dry grass is a reflectance variation, not bare soil. Give it a
    // meadow-scale field without reseeding physical soil/grass eligibility.
    meadowNoiseScale: 0.006,
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
    meadowDryStart: 0.43,
    meadowDryEnd: 0.6,
    meadowDryLow: 0,
    meadowDryHigh: 1,
    // Linear-reflectance multipliers, not sRGB values or baked illumination.
    // The pinned grass diffuse remains below 1 in every channel after tint.
    meadowFreshRed: 0.8,
    meadowFreshGreen: 1.25,
    meadowFreshBlue: 0.65,
    meadowDryRed: 1.85,
    meadowDryGreen: 1.25,
    meadowDryBlue: 1.2,
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
    plantingSoilStrength: 0.9,
    plantingEdgeWidth: 0.45,
    plantingEdgeNoiseWidth: 0.1,
    havenTalusCoreRadius: 0.6,
    havenTalusOuterRadius: 3.5,
    havenTalusStrength: 0.65,
    havenTalusRockFraction: 0.85,
    havenTalusSlopeStart: 0.008,
    havenTalusSlopeEnd: 0.05,
  };
  const palette = {
    grass: [0.12687350988906373, 0.16117143469264922, 0.03425721790414253],
    dirt: [0.13570346695867627, 0.10530763563352, 0.06788700038018664],
    rock: [0.2327181410040423, 0.14549203474325217, 0.08365218395286236],
  };
  const math = {
    smooth(a: number, b: number, value: number) {
      const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    mix(a: number, b: number, weight: number) {
      return a + (b - a) * weight;
    },
    ribbon(x: number, z: number, ribbon: CompactTerrainGroundRibbon) {
      const dx = ribbon.endX - ribbon.startX;
      const dz = ribbon.endZ - ribbon.startZ;
      const px = x - ribbon.startX;
      const pz = z - ribbon.startZ;
      const t = Math.max(
        0,
        Math.min(1, (px * dx + pz * dz) / (dx * dx + dz * dz)),
      );
      const crossX = px - t * dx;
      const crossZ = pz - t * dz;
      return (
        ribbon.strength *
        (1 -
          math.smooth(
            ribbon.coreRadius * ribbon.coreRadius,
            ribbon.outerRadius * ribbon.outerRadius,
            crossX * crossX + crossZ * crossZ,
          ))
      );
    },
  };
  const operations = {
    /** Once per worker boundary, never per grass candidate or terrain sample. */
    validatePlantingLobes(
      value: unknown,
    ): readonly CompactTerrainPlantingLobe[] {
      if (value === undefined || value === null) return Object.freeze([]);
      if (
        !Array.isArray(value) ||
        value.length > 4 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new Error("Invalid compact planting lobe list");
      const entries = Object.getOwnPropertyDescriptors(value);
      const result: CompactTerrainPlantingLobe[] = [];
      const keys = ["centerX", "centerZ", "radiusX", "radiusZ"] as const;
      for (let i = 0; i < value.length; i++) {
        const entry = entries[String(i)];
        if (!entry || !("value" in entry))
          throw new Error("Invalid compact planting lobe entry");
        const row: unknown = entry.value;
        if (
          !row ||
          typeof row !== "object" ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
          Reflect.ownKeys(row).length !== keys.length
        )
          throw new Error("Invalid compact planting lobe object");
        const properties = Object.getOwnPropertyDescriptors(row);
        const values = keys.map((key) => {
          const property = properties[key];
          if (
            !property ||
            !("value" in property) ||
            typeof property.value !== "number" ||
            !Number.isFinite(property.value)
          )
            throw new Error("Invalid compact planting lobe field");
          return property.value as number;
        });
        const [centerX, centerZ, radiusX, radiusZ] = values;
        if (
          Math.abs(centerX) > 10_000 ||
          Math.abs(centerZ) > 10_000 ||
          radiusX < 0.75 ||
          radiusX > 3 ||
          radiusZ < 0.75 ||
          radiusZ > 3
        )
          throw new Error("Compact planting lobe exceeds bounded domain");
        result.push(Object.freeze({ centerX, centerZ, radiusX, radiusZ }));
      }
      return Object.freeze(result);
    },
    /** No height or eligibility change; maximum preserves overlapped soil. */
    plantingSoil(
      x: number,
      z: number,
      distortNoise: number,
      lobes?: readonly CompactTerrainPlantingLobe[] | null,
    ): number {
      if (!lobes?.length) return 0;
      const c = composition;
      const edgeWidth =
        c.plantingEdgeWidth +
        c.plantingEdgeNoiseWidth *
          (2 * Math.max(0, Math.min(1, distortNoise)) - 1);
      let soil = 0;
      for (const lobe of lobes) {
        const dx = (x - lobe.centerX) / lobe.radiusX;
        const dz = (z - lobe.centerZ) / lobe.radiusZ;
        const inner = 1 - edgeWidth / Math.min(lobe.radiusX, lobe.radiusZ);
        soil = Math.max(
          soil,
          c.plantingSoilStrength *
            (1 - math.smooth(inner * inner, 1, dx * dx + dz * dz)),
        );
      }
      return soil;
    },
    grassEligibility(
      value: unknown,
      algorithm: string,
    ): GrassSurfaceEligibility {
      if (value === undefined || value === "legacy-biome-v1")
        return "legacy-biome-v1";
      if (
        value !== "compact-pbr-v1" ||
        (algorithm !== "compact-island-sculpt-v2" &&
          algorithm !== "compact-island-sculpt-v3" &&
          algorithm !== "compact-island-sculpt-v4" &&
          algorithm !== "compact-island-sculpt-v5")
      ) {
        throw new Error("Invalid compact grass surface eligibility");
      }
      return "compact-pbr-v1";
    },
    macroField(profile: WorldTerrainProfile): CompactTerrainMacroField | null {
      if (
        profile.algorithm !== "compact-island-sculpt-v2" &&
        profile.algorithm !== "compact-island-sculpt-v3" &&
        profile.algorithm !== "compact-island-sculpt-v4" &&
        profile.algorithm !== "compact-island-sculpt-v5"
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
      if (!profile.havenShoulder) return Object.freeze(field);
      // The profile boundary already admitted this curve. Detach its XZ knots
      // once; no height resampling, second landform, or per-candidate allocation.
      const points = profile.havenShoulder.toe;
      if (points.length < 2 || points.length > 16)
        throw new Error("Invalid admitted Haven ground curve");
      const talus: CompactTerrainGroundRibbon[] = [];
      for (let i = 1; i < points.length; i++) {
        const [startX, startZ] = points[i - 1];
        const [endX, endZ] = points[i];
        if (
          ![startX, startZ, endX, endZ].every(Number.isFinite) ||
          (startX === endX && startZ === endZ)
        )
          throw new Error("Invalid admitted Haven ground segment");
        talus.push(
          Object.freeze({
            startX,
            startZ,
            endX,
            endZ,
            coreRadius: composition.havenTalusCoreRadius,
            outerRadius: composition.havenTalusOuterRadius,
            strength: composition.havenTalusStrength,
          }),
        );
      }
      // Connected working-yard footprints in the existing authored court.
      // These are not paths, collision envelopes, or camera-relative regions.
      const wear = Object.freeze([
        Object.freeze({
          startX: 334,
          startZ: 332,
          endX: 337,
          endZ: 344,
          coreRadius: 2.7,
          outerRadius: 4.2,
          strength: 0.88,
        }),
        Object.freeze({
          startX: 337,
          startZ: 344,
          endX: 343,
          endZ: 348,
          coreRadius: 1.7,
          outerRadius: 3.2,
          strength: 0.65,
        }),
      ]);
      return Object.freeze({
        ...field,
        havenGround: Object.freeze({
          talus: Object.freeze(talus),
          wear,
        }),
      });
    },
    havenGroundWeights(
      x: number,
      z: number,
      field?: CompactTerrainHavenGround | null,
      geometricSlope = 0,
    ) {
      let talus = 0;
      let wear = 0;
      if (field) {
        // MAX of continuous bounded segment kernels avoids nearest-segment
        // selection discontinuities and overlapping additive dark rings.
        for (const ribbon of field.talus)
          talus = Math.max(talus, math.ribbon(x, z, ribbon));
        for (const ribbon of field.wear)
          wear = Math.max(wear, math.ribbon(x, z, ribbon));
      }
      // A mineral transition at the hillside foot, not a paved stripe across
      // level lawn. Geometric slope alone controls this colour/PBR gate;
      // the vegetation support function remains completely independent.
      return {
        talus:
          talus *
          math.smooth(
            composition.havenTalusSlopeStart,
            composition.havenTalusSlopeEnd,
            Math.max(0, Math.min(1, geometricSlope)),
          ),
        wear,
      };
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
        math.mix(
          math.mix(c.meadowFreshRed, c.meadowDryRed, dryness),
          c.macroDryRed,
          macroDry,
        ),
        math.mix(
          math.mix(c.meadowFreshGreen, c.meadowDryGreen, dryness),
          c.macroDryGreen,
          macroDry,
        ),
        math.mix(
          math.mix(c.meadowFreshBlue, c.meadowDryBlue, dryness),
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
      plantingSoil?: number;
    }) {
      // Meadow earth follows the shared patch field; rock uses geometric slope,
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
            (1 - (input.pondSurface?.soil ?? 0)) *
            (1 - (input.plantingSoil ?? 0)),
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
      meadowNoise?: number;
      distortNoise: number;
      slope: number;
      roadInfluence: number;
      surface?: {
        x: number;
        z: number;
        height: number;
        pond: CompactTerrainPond | null;
        macroField?: CompactTerrainMacroField | null;
        plantingLobes?: readonly CompactTerrainPlantingLobe[] | null;
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
        plantingSoil: input.surface
          ? operations.plantingSoil(
              input.surface.x,
              input.surface.z,
              input.distortNoise,
              input.surface.plantingLobes,
            )
          : 0,
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
        input.meadowNoise ?? input.noiseValue,
        macroSurface.dry,
      );
      const havenGround = input.surface?.macroField?.havenGround;
      const authored = operations.havenGroundWeights(
        input.surface?.x ?? 0,
        input.surface?.z ?? 0,
        havenGround,
        input.slope,
      );
      // The existing authored pond bed remains soil even if future admitted
      // ground ribbons overlap it. This changes neither pond geometry nor water.
      const talus = authored.talus * (1 - pondSurface.soil);
      const result = palette.grass.map((grass, channel) => {
        const rock =
          math.mix(palette.rock[channel], palette.dirt[channel], coast.soil) *
          math.mix(1, composition.coastWetAlbedo, coast.wetness);
        let ground = math.mix(
          grass * (havenGround ? 1 : meadowTint[channel]),
          palette.dirt[channel],
          dirt,
        );
        if (havenGround) {
          ground = math.mix(
            ground,
            math.mix(
              palette.dirt[channel],
              rock,
              composition.havenTalusRockFraction,
            ),
            talus,
          );
          ground = math.mix(ground, palette.dirt[channel], authored.wear);
        }
        return (
          math.mix(math.mix(ground, rock, cliff), palette.dirt[channel], road) *
          variation *
          wetAlbedo
        );
      });
      return { r: result[0], g: result[1], b: result[2] };
    },
  };
  return operations;
}

export const COMPACT_TERRAIN_COMPOSITION = Object.freeze(
  createCompactTerrainColorOperations().getComposition(),
);
