import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import type { GrassSurfaceEligibility } from "../../../runtime/clientViewportMode";
import type {
  FlatZone,
  RadialPondBankSurface,
  RadialPondBankGroundCover,
} from "../../../types/world/terrain";

/** Restart-owned fine-meadow trial, never a change to raw scan calibration. */
export type CompactGrassColorGrade = "fine-meadow-green-v1";
/** Restart-owned coastal appearance; no terrain-height or navigation change. */
export type CompactCoastBlend = "detail-v1" | "distribution-v1" | "cavity-v1";
/** Restart-owned pond appearance; historical modes do not alter grass support. */
export type CompactPondBlend =
  "relief-v1" | "relief-contact-v1" | "shore-contact-v1" | "composition-v1";
/** Detached, restart-owned projection of actual admitted geometry and water. */
export type CompactPondBankField = Readonly<{
  id: "composition-v1";
  zoneId: string;
  centerX: number;
  centerZ: number;
  bedHeight: number;
  bedRadius: number;
  bankInnerRadius: number;
  bankOuterRadius: number;
  bankHeight: number;
  blendRadius: number;
  shorelineAmplitude: number;
  pond: CompactTerrainPond;
  sectors: readonly Readonly<{
    bearing: number;
    halfWidth: number;
    innerRadius: number;
    innerHeight: number;
    outerRadius?: number;
    outerHeight?: number;
    surface?: RadialPondBankSurface;
    groundCover?: RadialPondBankGroundCover;
  }>[];
}>;
export type CompactPondBankMath<T> = CompactCoastDistributionMath<T> &
  Readonly<{
    sqrt(value: T): T;
    abs(value: T): T;
    sin(value: T): T;
    atan2(y: T, x: T): T;
  }>;
export type CompactPondBankCompositionInput<T> = Readonly<{
  x: T;
  z: T;
  height: T;
  slope: T;
  distortNoise: T;
  roadInfluence: T;
  field: CompactPondBankField | null;
  /** Appearance is omitted from CPU placement/eligibility-only evaluations. */
  includeAppearance?: true;
}>;
export type CompactPondBankComposition<T> = Readonly<{
  soilToGrass: T;
  soilToRock: T;
  /** Authored mineral substrate consumes soil after emergence, never grass. */
  mineralSoilToRock?: T;
  /** Cutbank shoulder appearance consumes only the final remaining soil. */
  substrateSoilToRock?: T;
  /** Material families only; never consumed by coverage or grass support. */
  mineralAppearance?: T;
  siltAppearance?: T;
  grassToSoil: T;
  grassToRock: T;
  grassShade: T;
  /** Authored-domain weight and weighted target share of the grass/soil budget. */
  groundCoverWeight: T;
  groundCoverGrassShare: T;
}>;
export type CompactPondDistributionDescriptor = Readonly<{
  id: "shore-contact-v1";
  soilFullHeight: number;
  soilEndHeight: number;
}>;
export type CompactPondDistributionMath<T> = Pick<
  CompactCoastDistributionMath<T>,
  "constant" | "add" | "sub" | "mul" | "smoothstep"
>;
export type CompactPondMarginInput<T> = Readonly<{
  x: T;
  z: T;
  height: T;
  slope: T;
  meadowNoise: T;
  distortNoise: T;
  roadInfluence: T;
  pond: Readonly<{ centerX: T; centerZ: T; radius: T; surfaceY: T }> | null;
  field: CompactTerrainMacroField | null;
}>;
export type CompactPondMargin<T> = Readonly<{
  cover: T;
  exposure: T;
  shade: T;
  clumpScale: T;
}>;
export type CompactCoastDistributionDescriptor = Readonly<{
  id: "distribution-v1";
  coastCoverageFull: number;
  turfSlopeStart: number;
  turfSlopeEnd: number;
  bedrockSlopeStart: number;
  bedrockSlopeEnd: number;
  slopeNoise: number;
}>;
export type CompactCoastDistributionMath<T> = Readonly<{
  constant(value: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  min(a: T, b: T): T;
  max(a: T, b: T): T;
  clamp(a: T, low: number, high: number): T;
  smoothstep(low: T, high: T, value: T): T;
}>;
export type CompactCoastDistributionInput<T> = Readonly<{
  x: T;
  z: T;
  height: T;
  slope: T;
  noiseValue: T;
  meadowNoise: T;
  /** Final processed road coverage, not raw road influence. */
  road: T;
  pond: Readonly<{ centerX: T; centerZ: T; radius: T }> | null;
  field: CompactTerrainMacroField | null;
}>;
export type CompactCoastDistribution<T> = Readonly<{
  turfRetention: T;
  bedrockShare: T;
}>;
export type CompactGrassColorGradeDescriptor = Readonly<{
  id: CompactGrassColorGrade;
  linearMultipliers: readonly [number, number, number];
}>;

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

/** One authored bank verge: surface/grass scale only, never route eligibility. */
export type CompactTerrainBankVerge = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  feather: number;
  wearStart: number;
  wearEnd: number;
  minimumScale: number;
  /** Additional vertical-only blade scale, independent of clump footprint. */
  heightScale: number;
  /** Connected appearance-only wear; never feeds road or root eligibility. */
  wear: readonly CompactTerrainGroundRibbon[];
  /** Height at full authored wear, before the existing locality feather. */
  wornHeightScale: number;
  /** Linear grass reflectance only; never soil tint or illumination. */
  grassTint: readonly [number, number, number];
  tipBrightness: number;
}>;

/** Detached appearance view of the admitted landform, never new terrain.
 * Explicit coast/pond distributions also own decorative grass support/colors. */
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
  /** Restart-owned southern-meadow candidate; omitted by existing worlds. */
  coastalMeadow?: true;
  /** Shared ground/grass distribution; absent in historical visual modes. */
  coastalDistribution?: CompactCoastDistributionDescriptor;
  /** Center-preserving pond soil transition; absent in historical modes. */
  pondDistribution?: CompactPondDistributionDescriptor;
  /** Present (possibly null for remote worker jobs) only in composition mode. */
  pondBankField?: CompactPondBankField | null;
  havenGround?: CompactTerrainHavenGround;
  bankVerge?: CompactTerrainBankVerge;
  /** Candidate dry contact substrate; never pond wetness or grass support. */
  pondContactGround?: readonly CompactTerrainGroundRibbon[];
}>;

type CompactGrassSupportInput = {
  noiseValue: number;
  distortNoise: number;
  slope: number;
  roadInfluence?: number;
  meadowNoise?: number;
  surface: {
    x: number;
    z: number;
    height: number;
    pond: CompactTerrainPond | null;
    macroField?: CompactTerrainMacroField | null;
  };
};

export function createCompactTerrainColorOperations() {
  // Retain the historical .11 m midpoint and the same bank-noise displacement.
  // This is material/root support only, never water, terrain or route geometry.
  const pondDistribution: CompactPondDistributionDescriptor = Object.freeze({
    id: "shore-contact-v1",
    soilFullHeight: 0.055,
    soilEndHeight: 0.165,
  });
  // Explicit shore-contact art hypothesis: broad groundcover/exposed-sediment
  // patches also grade existing grass. Not geological or ecological constants.
  const pondMarginRecipe = Object.freeze({
    radiusFullOffset: 1,
    radiusEndOffset: 3,
    heightRiseStart: 0.035,
    heightRiseEnd: 0.105,
    heightFadeStart: 0.35,
    heightFadeEnd: 0.85,
    slopeFadeStart: 0.08,
    slopeFadeEnd: 0.22,
    roadEnd: 0.8,
    meadowFraction: 0.65,
    patchStart: 0.4,
    patchEnd: 0.55,
    coverStrength: 0.75,
    exposureStrength: 0.45,
    shadeStrength: 0.22,
    shadeBase: 0.3,
    clumpScaleStrength: 0.45,
    clumpScaleBase: 0.35,
  });
  // Authored surface families, not ecological constants or another height solver.
  // No grass-scale or density change: existing accepted roots keep their shape.
  const pondBankRecipe = Object.freeze({
    waterRiseStart: 0.1,
    waterRiseEnd: 0.18,
    flatStart: 0.08,
    flatEnd: 0.24,
    cutRockStart: 0.1,
    cutRockEnd: 0.32,
    cutRockShare: 0.55,
    cutExposure: 0.82,
    sedgeCover: 0.68,
    turfCover: 0.9,
    sedgeShade: 0.16,
    turfShade: 0.08,
    patchMinimum: 0.8,
    roadEnd: 0.8,
    mineralFadeStart: 0.1,
    mineralFadeEnd: 0.3,
    mineralPatchStart: 0.35,
    mineralPatchEnd: 0.65,
    mineralPatchMinimum: 0.35,
    substrateMax: 0.72,
    substratePatchMinimum: 0.65,
    substrateRiseStart: -1.2,
    substrateRiseEnd: -0.25,
    substrateFadeStart: 0.65,
    substrateFadeEnd: 1.7,
    substrateHeightNoise: 0.08,
    appearanceRiseStart: -1.7,
    appearanceRiseEnd: -0.7,
    appearanceFadeStart: 0.65,
    appearanceFadeEnd: 1.7,
    appearanceHeightNoise: 0.16,
    appearancePatchMinimum: 0.85,
    // Turf toes retain the soil scan; exposed cutbank/mineral sectors own the
    // mineral grade. Giving every family that grade produced a pale pond rim.
    // This changes material appearance only, never emergence or root support.
    turfMineralStrength: 0,
    turfMineralFadeStart: 0.04,
    turfMineralFadeEnd: 0.35,
    siltStrength: 0.78,
    siltFadeStart: 0.08,
    siltFadeEnd: 0.5,
    mineralChroma: 0.18,
    mineralValue: 1.16,
    mineralTint: Object.freeze([1.06, 1.03, 0.96] as const),
    siltChroma: 0.3,
    siltValue: 0.75,
    siltTint: Object.freeze([1, 0.98, 0.88] as const),
  });
  // One native-transect-calibrated trial; these are appearance thresholds in
  // slope=1-abs(normal.y), not collision or navigation slope limits.
  const coastalDistribution: CompactCoastDistributionDescriptor = Object.freeze(
    {
      id: "distribution-v1",
      coastCoverageFull: 0.25,
      turfSlopeStart: 0.04,
      turfSlopeEnd: 0.09,
      bedrockSlopeStart: 0.11,
      bedrockSlopeEnd: 0.23,
      slopeNoise: 0.005,
    },
  );
  // Admitted bank (348,318), apron and NPC approaches. The feather is INSIDE
  // these bounds; existing meadow and path styling outside remain exact.
  const bankVerge = Object.freeze({
    minX: 340,
    maxX: 357,
    minZ: 310,
    maxZ: 324,
    feather: 2,
    wearStart: 0.1,
    wearEnd: 0.8,
    minimumScale: 0.55,
    heightScale: 0.65,
    // The actual bank-apron, clerk and shopkeeper approach endpoints. Unequal
    // connected shoulders explain bare service ground without widening paths
    // or changing the station/lodge grass exclusions.
    wear: Object.freeze([
      Object.freeze({
        startX: 346,
        startZ: 319,
        endX: 350,
        endZ: 319.5,
        coreRadius: 0.7,
        outerRadius: 1.55,
        strength: 0.8,
      }),
      Object.freeze({
        startX: 350,
        startZ: 319.5,
        endX: 354,
        endZ: 321,
        coreRadius: 0.6,
        outerRadius: 1.35,
        strength: 0.62,
      }),
      Object.freeze({
        startX: 346,
        startZ: 319,
        endX: 342.5,
        endZ: 322,
        coreRadius: 0.55,
        outerRadius: 1.2,
        strength: 0.55,
      }),
    ]),
    wornHeightScale: 0.35,
    grassTint: Object.freeze([0.96, 0.88, 1] as const),
    tipBrightness: 1.08,
  });
  // Unequal dry-soil contacts connect the selected pond's northern shelf and
  // shoulder to their habitat groups. Deliberately not a radial shoreline
  // band: the open southern fishing approach retains its existing surface.
  const pondContactGround = Object.freeze([
    Object.freeze({
      startX: 338.9,
      startZ: 297.6,
      endX: 337.2,
      endZ: 295.8,
      coreRadius: 0.6,
      outerRadius: 1.8,
      strength: 0.75,
    }),
    Object.freeze({
      startX: 348.35,
      startZ: 299.28,
      endX: 350.13,
      endZ: 298.37,
      coreRadius: 0.45,
      outerRadius: 1.25,
      strength: 0.55,
    }),
  ]);
  const grassColorGradeDescriptor: CompactGrassColorGradeDescriptor =
    Object.freeze({
      id: "fine-meadow-green-v1",
      linearMultipliers: Object.freeze([0.95, 1.3, 1.1] as const),
    });
  const composition = {
    // Fresh/dry grass is a reflectance variation, not bare soil. Give it a
    // meadow-scale field without reseeding physical soil/grass eligibility.
    meadowNoiseScale: 0.006,
    // The coastal candidate keeps the soft fine-blade substrate but restores
    // connected fresh/dry patches. Neutral-to-authored tint, not extra soil,
    // grass rejection, illumination or a change to the existing Haven default.
    coastalMeadowTintStrength: 0.4,
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
    // Metres above the sea, not a fraction of the inland plateau height.
    // Two existing noise bands interrupt the margin without a new texture.
    coastalGroundFullLow: 0.6,
    coastalGroundFullHigh: 1.8,
    coastalGroundEndLow: 3.8,
    coastalGroundEndHigh: 6.2,
    variationLow: 0.98,
    variationHigh: 1.02,
    pathEdgeNoiseContrast: 2.5,
    pathEdgeStartLow: 0.04,
    pathEdgeStartHigh: 0.26,
    pathEdgeEndLow: 0.74,
    pathEdgeEndHigh: 0.96,
    // Appearance only. The selected meadow reuses the existing broad/edge
    // noise; these values never enter grass eligibility or route geometry.
    turfMeadowFraction: 0.55,
    turfPatchStart: 0.35,
    turfPatchEnd: 0.65,
    turfFlatStart: 0.04,
    turfFlatEnd: 0.18,
    turfSoilStrength: 0.3,
    turfEdgeStartLow: 0.12,
    turfEdgeStartHigh: 0.36,
    turfEdgeEndLow: 0.64,
    turfEdgeEndHigh: 0.88,
    turfCoreStart: 0.7,
    turfCoreEnd: 0.8,
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
    dirt: [0.1258525186051025, 0.08567628015146961, 0.0490416307568836],
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
  const distributionMath: CompactCoastDistributionMath<number> = {
    constant(value) {
      return value;
    },
    add(a, b) {
      return a + b;
    },
    sub(a, b) {
      return a - b;
    },
    mul(a, b) {
      return a * b;
    },
    div(a, b) {
      return a / b;
    },
    min: Math.min,
    max: Math.max,
    clamp(value, low, high) {
      return Math.max(low, Math.min(high, value));
    },
    smoothstep: math.smooth,
  };
  const bankMath: CompactPondBankMath<number> = {
    ...distributionMath,
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    atan2: Math.atan2,
  };
  const bankAdmission = {
    record(value: unknown): Record<string, unknown> {
      if (
        !value ||
        typeof value !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      )
        throw new Error("Invalid pond bank data record");
      return value as Record<string, unknown>;
    },
    value(owner: object, key: string): unknown {
      const entry = Object.getOwnPropertyDescriptor(owner, key);
      if (!entry?.enumerable || !("value" in entry))
        throw new Error("Pond bank fields must be own data values");
      return entry.value;
    },
    number(owner: object, key: string): number {
      const value = bankAdmission.value(owner, key);
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("Pond bank fields must be finite numbers");
      return value;
    },
    list(value: unknown): unknown[] {
      if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 4 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new Error("Invalid pond bank dense sector list");
      for (let i = 0; i < value.length; i++)
        bankAdmission.value(value, String(i));
      return value;
    },
    pond(value: unknown): CompactTerrainPond {
      const row = bankAdmission.record(value),
        id = bankAdmission.value(row, "id");
      const centerX = bankAdmission.number(row, "centerX"),
        centerZ = bankAdmission.number(row, "centerZ"),
        radius = bankAdmission.number(row, "radius"),
        surfaceY = bankAdmission.number(row, "surfaceY");
      if (
        Reflect.ownKeys(row).length !== 5 ||
        typeof id !== "string" ||
        !id ||
        id.length > 256 ||
        radius <= 0 ||
        radius > 128
      )
        throw new Error("Invalid pond bank water identity");
      return Object.freeze({ id, centerX, centerZ, radius, surfaceY });
    },
    groundCover(value: unknown): RadialPondBankGroundCover {
      const row = bankAdmission.record(value);
      const emergenceHeight = bankAdmission.number(row, "emergenceHeight");
      const fullHeight = bankAdmission.number(row, "fullHeight");
      if (
        Reflect.ownKeys(row).length !== 2 ||
        emergenceHeight <= 0 ||
        fullHeight < emergenceHeight + 0.01 ||
        fullHeight > 0.6
      )
        throw new Error(
          "Invalid pond bank groundCover: positive emergence, at least 0.01m width, fullHeight <= 0.6",
        );
      return Object.freeze({ emergenceHeight, fullHeight });
    },
  };
  const admittedBankFields = new WeakSet<object>();
  const operations = {
    pondBlend(value: unknown): CompactPondBlend | undefined {
      if (
        value === undefined ||
        value === "relief-v1" ||
        value === "relief-contact-v1" ||
        value === "shore-contact-v1" ||
        value === "composition-v1"
      )
        return value;
      throw new Error("Invalid compact pond blend");
    },
    /** The caller validates the full zone/snapshot first. Recheck the selected
     * projection before copying so no live getters or mutable source escape. */
    pondBankField(
      zone: FlatZone | null,
      pond: CompactTerrainPond | null,
    ): CompactPondBankField | null {
      if (!pond) return null; // A remote zone-only snapshot is legitimate.
      if (!zone)
        throw new Error("Pond bank composition requires its admitted zone");
      const z = bankAdmission.record(zone);
      const radial = bankAdmission.record(bankAdmission.value(z, "radialPond"));
      const authored = bankAdmission.record(
        bankAdmission.value(radial, "bankComposition"),
      );
      if (
        Reflect.ownKeys(authored).length !== 2 ||
        bankAdmission.value(authored, "schemaVersion") !== 1
      )
        throw new Error("Invalid pond bank composition schema");
      const rows = bankAdmission.list(bankAdmission.value(authored, "sectors"));
      const geometry = bankAdmission.list(
        bankAdmission.value(radial, "bankSectors"),
      );
      const surfaces = new Map<number, RadialPondBankSurface>();
      const groundCovers = new Map<number, RadialPondBankGroundCover>();
      for (const value of rows) {
        const row = bankAdmission.record(value);
        const index = bankAdmission.number(row, "sectorIndex");
        const surface = bankAdmission.value(row, "surface");
        if (
          Reflect.ownKeys(row).length !== ("groundCover" in row ? 3 : 2) ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= geometry.length ||
          surfaces.has(index) ||
          (surface !== "sedge-shelf" &&
            surface !== "cutbank" &&
            surface !== "dry-turf" &&
            surface !== "mineral-shore")
        )
          throw new Error("Invalid pond bank composition sector");
        surfaces.set(index, surface);
        if (surface === "mineral-shore" && "groundCover" in row)
          throw new Error("Pond mineral-shore cannot establish groundCover");
        if ("groundCover" in row)
          groundCovers.set(
            index,
            bankAdmission.groundCover(bankAdmission.value(row, "groundCover")),
          );
      }
      const admittedPond = bankAdmission.pond(pond);
      const zoneId = bankAdmission.value(z, "id");
      const centerX = bankAdmission.number(z, "centerX");
      const centerZ = bankAdmission.number(z, "centerZ");
      const bedHeight = bankAdmission.number(z, "height");
      const bedRadius = bankAdmission.number(radial, "bedRadius");
      const bankInnerRadius = bankAdmission.number(radial, "bankInnerRadius");
      const bankOuterRadius = bankAdmission.number(radial, "bankOuterRadius");
      const bankHeight = bankAdmission.number(radial, "bankHeight");
      const blendRadius = bankAdmission.number(z, "blendRadius");
      const shorelineAmplitude =
        "shorelineAmplitude" in radial
          ? bankAdmission.number(radial, "shorelineAmplitude")
          : 0;
      if (
        typeof zoneId !== "string" ||
        !zoneId ||
        zoneId.length > 256 ||
        centerX !== admittedPond.centerX ||
        centerZ !== admittedPond.centerZ ||
        bedRadius <= 0 ||
        bankInnerRadius <= bedRadius ||
        bankOuterRadius < bankInnerRadius ||
        bankHeight <= bedHeight ||
        blendRadius <= 0 ||
        bedHeight >= admittedPond.surfaceY ||
        bankHeight <= admittedPond.surfaceY ||
        shorelineAmplitude < 0 ||
        shorelineAmplitude >
          Math.min(
            1,
            bedRadius * 0.25,
            (bankOuterRadius - bankInnerRadius) * 0.5,
          )
      )
        throw new Error("Pond bank composition geometry/water mismatch");
      const sectors = geometry.map((value, index) => {
        const row = bankAdmission.record(value);
        const bearing = bankAdmission.number(row, "bearing");
        const halfWidth = bankAdmission.number(row, "halfWidth");
        const innerRadius = bankAdmission.number(row, "innerRadius");
        const innerHeight = bankAdmission.number(row, "innerHeight");
        const paired = "outerRadius" in row;
        if (
          paired !== "outerHeight" in row ||
          Reflect.ownKeys(row).length !== (paired ? 6 : 4) ||
          bearing < -Math.PI ||
          bearing > Math.PI ||
          halfWidth <= 0 ||
          halfWidth > Math.PI / 2 ||
          innerRadius <= bedRadius ||
          innerRadius >= bankOuterRadius ||
          innerHeight <= bedHeight ||
          innerHeight > bankHeight
        )
          throw new Error("Invalid pond bank geometry sector");
        const outerRadius = paired
          ? bankAdmission.number(row, "outerRadius")
          : undefined;
        const outerHeight = paired
          ? bankAdmission.number(row, "outerHeight")
          : undefined;
        if (
          outerRadius !== undefined &&
          outerHeight !== undefined &&
          (outerRadius <= innerRadius ||
            outerRadius >= bankOuterRadius + blendRadius ||
            outerHeight < innerHeight ||
            outerHeight > bankHeight + 0.6)
        )
          throw new Error("Invalid pond bank outer knot");
        const surface = surfaces.get(index);
        const groundCover = groundCovers.get(index);
        return Object.freeze({
          bearing,
          halfWidth,
          innerRadius,
          innerHeight,
          ...(paired ? { outerRadius, outerHeight } : {}),
          ...(surface ? { surface } : {}),
          ...(groundCover ? { groundCover } : {}),
        });
      });
      const result: CompactPondBankField = Object.freeze({
        id: "composition-v1",
        zoneId,
        centerX,
        centerZ,
        bedHeight,
        bedRadius,
        bankInnerRadius,
        bankOuterRadius,
        bankHeight,
        blendRadius,
        shorelineAmplitude,
        pond: Object.freeze({ ...admittedPond }),
        sectors: Object.freeze(sectors),
      });
      admittedBankFields.add(result);
      return result;
    },
    /** Re-admit detached cross-owner/structured-clone descriptors; never trust
     * caller-authored indices, getters, or a mutable copy as a live binding. */
    validatePondBankField(value: unknown): CompactPondBankField {
      const f = bankAdmission.record(value);
      if (admittedBankFields.has(f)) return f as CompactPondBankField;
      if (
        Reflect.ownKeys(f).length !== 13 ||
        bankAdmission.value(f, "id") !== "composition-v1"
      )
        throw new Error("Invalid pond bank field schema");
      const zoneId = bankAdmission.value(f, "zoneId");
      if (typeof zoneId !== "string")
        throw new Error("Invalid pond bank zone identity");
      const sectors = bankAdmission.list(bankAdmission.value(f, "sectors"));
      const compositionRows: {
        sectorIndex: number;
        surface: RadialPondBankSurface;
        groundCover?: RadialPondBankGroundCover;
      }[] = [];
      const geometry = sectors.map((value, index) => {
        const row = bankAdmission.record(value);
        const surface =
          "surface" in row ? bankAdmission.value(row, "surface") : undefined;
        if (surface !== undefined) {
          if (
            surface !== "sedge-shelf" &&
            surface !== "cutbank" &&
            surface !== "dry-turf" &&
            surface !== "mineral-shore"
          )
            throw new Error("Invalid pond bank surface family");
          if (surface === "mineral-shore" && "groundCover" in row)
            throw new Error("Pond mineral-shore cannot establish groundCover");
          compositionRows.push({
            sectorIndex: index,
            surface,
            ...("groundCover" in row
              ? {
                  groundCover: bankAdmission.groundCover(
                    bankAdmission.value(row, "groundCover"),
                  ),
                }
              : {}),
          });
        }
        const paired = "outerRadius" in row;
        if (
          paired !== "outerHeight" in row ||
          Reflect.ownKeys(row).length !==
            (paired ? 6 : 4) +
              (surface === undefined ? 0 : 1) +
              (surface !== undefined && "groundCover" in row ? 1 : 0)
        )
          throw new Error("Invalid pond bank field sector keys");
        return {
          bearing: bankAdmission.number(row, "bearing"),
          halfWidth: bankAdmission.number(row, "halfWidth"),
          innerRadius: bankAdmission.number(row, "innerRadius"),
          innerHeight: bankAdmission.number(row, "innerHeight"),
          ...(paired
            ? {
                outerRadius: bankAdmission.number(row, "outerRadius"),
                outerHeight: bankAdmission.number(row, "outerHeight"),
              }
            : {}),
        };
      });
      const blendRadius = bankAdmission.number(f, "blendRadius"),
        bankOuterRadius = bankAdmission.number(f, "bankOuterRadius");
      const zone: FlatZone = {
        id: zoneId,
        centerX: bankAdmission.number(f, "centerX"),
        centerZ: bankAdmission.number(f, "centerZ"),
        width: 2 * (bankOuterRadius + blendRadius),
        depth: 2 * (bankOuterRadius + blendRadius),
        height: bankAdmission.number(f, "bedHeight"),
        blendRadius,
        radialPond: {
          bedRadius: bankAdmission.number(f, "bedRadius"),
          bankInnerRadius: bankAdmission.number(f, "bankInnerRadius"),
          bankOuterRadius,
          bankHeight: bankAdmission.number(f, "bankHeight"),
          shorelineAmplitude: bankAdmission.number(f, "shorelineAmplitude"),
          bankSectors: geometry,
          bankComposition: { schemaVersion: 1, sectors: compositionRows },
        },
      };
      const pond = bankAdmission.pond(bankAdmission.value(f, "pond"));
      const result = operations.pondBankField(zone, pond);
      if (!result) throw new Error("Invalid pond bank field");
      return result;
    },
    getPondBankRecipe() {
      return pondBankRecipe;
    },
    /** Identical warped radial coordinates and normalized overlap weights to
     * the authored owner; the original height is an input, never solved here. */
    bankComposition<T>(
      input: CompactPondBankCompositionInput<T>,
      m: CompactPondBankMath<T>,
    ): CompactPondBankComposition<T> {
      const zero = m.constant(0),
        one = m.constant(1),
        f = input.field,
        c = pondBankRecipe;
      if (!f)
        return {
          soilToGrass: zero,
          soilToRock: zero,
          grassToSoil: zero,
          grassToRock: zero,
          grassShade: one,
          groundCoverWeight: zero,
          groundCoverGrassShare: zero,
        };
      const dx = m.sub(input.x, m.constant(f.centerX)),
        dz = m.sub(input.z, m.constant(f.centerZ));
      const rawRadius = m.sqrt(m.add(m.mul(dx, dx), m.mul(dz, dz)));
      const angle = m.atan2(dz, dx);
      let radius = rawRadius;
      if (f.shorelineAmplitude > 0) {
        const inner = m.smoothstep(
          zero,
          m.constant(f.bedRadius * 0.5),
          rawRadius,
        );
        const outer = m.sub(
          one,
          m.smoothstep(
            m.constant(f.bankInnerRadius),
            m.constant(f.bankOuterRadius),
            rawRadius,
          ),
        );
        const lobe = m.add(
          m.add(
            m.mul(
              m.constant(0.55),
              m.sin(m.add(m.mul(m.constant(2), angle), m.constant(0.7))),
            ),
            m.mul(
              m.constant(0.3),
              m.sin(m.sub(m.mul(m.constant(3), angle), m.constant(0.4))),
            ),
          ),
          m.mul(
            m.constant(0.15),
            m.sin(m.add(m.mul(m.constant(5), angle), m.constant(1.2))),
          ),
        );
        radius = m.sub(
          radius,
          m.mul(
            m.mul(m.mul(m.constant(f.shorelineAmplitude), lobe), inner),
            outer,
          ),
        );
      }
      let sum = zero,
        sedge = zero,
        cut = zero,
        turf = zero,
        mineral = zero,
        groundCoverWeight = zero,
        groundCoverGrassShare = zero;
      for (const sector of f.sectors) {
        const difference = m.abs(m.sub(angle, m.constant(sector.bearing)));
        const distance = m.min(
          difference,
          m.sub(m.constant(2 * Math.PI), difference),
        );
        const weight = m.sub(
          one,
          m.smoothstep(zero, m.constant(sector.halfWidth), distance),
        );
        sum = m.add(sum, weight); // Unmapped geometry still dilutes mapped sections.
        if (!sector.surface) continue;
        const entry = m.smoothstep(
          m.constant(f.bedRadius),
          m.constant(sector.innerRadius),
          radius,
        );
        const end = sector.outerRadius ?? sector.innerRadius;
        const exit = m.sub(
          one,
          m.smoothstep(
            m.constant(end),
            m.constant(
              sector.outerRadius === undefined
                ? f.bankOuterRadius
                : f.bankOuterRadius + f.blendRadius,
            ),
            radius,
          ),
        );
        const span = m.mul(m.mul(weight, entry), exit);
        if (sector.groundCover) {
          // A broad existing world-noise field perturbs emergence by at most
          // one centimetre, never enough to establish submerged groundcover.
          const shift = m.mul(
            m.sub(m.clamp(input.distortNoise, 0, 1), m.constant(0.5)),
            m.constant(
              2 * Math.min(0.01, sector.groundCover.emergenceHeight * 0.25),
            ),
          );
          const emerged = m.smoothstep(
            m.add(m.constant(sector.groundCover.emergenceHeight), shift),
            m.add(m.constant(sector.groundCover.fullHeight), shift),
            m.sub(input.height, m.constant(f.pond.surfaceY)),
          );
          groundCoverWeight = m.add(groundCoverWeight, span);
          groundCoverGrassShare = m.add(
            groundCoverGrassShare,
            m.mul(span, emerged),
          );
        }
        if (sector.surface === "sedge-shelf") sedge = m.add(sedge, span);
        else if (sector.surface === "cutbank") cut = m.add(cut, span);
        else if (sector.surface === "dry-turf") turf = m.add(turf, span);
        else if (sector.surface === "mineral-shore")
          mineral = m.add(mineral, span);
      }
      const denominator = m.max(one, sum);
      sedge = m.div(sedge, denominator);
      cut = m.div(cut, denominator);
      turf = m.div(turf, denominator);
      const outerRadius = f.pond.radius + composition.pondBankReach;
      const region = m.sub(
        one,
        m.smoothstep(
          m.constant(outerRadius - composition.pondRadialFade),
          m.constant(outerRadius),
          rawRadius,
        ),
      );
      const aboveWater = m.smoothstep(
        m.constant(c.waterRiseStart),
        m.constant(c.waterRiseEnd),
        m.sub(input.height, m.constant(f.pond.surfaceY)),
      );
      const roads = m.sub(
        one,
        m.smoothstep(
          zero,
          m.constant(c.roadEnd),
          m.clamp(input.roadInfluence, 0, 1),
        ),
      );
      const locality = m.mul(m.mul(region, aboveWater), roads);
      const flat = m.sub(
        one,
        m.smoothstep(
          m.constant(c.flatStart),
          m.constant(c.flatEnd),
          m.clamp(input.slope, 0, 1),
        ),
      );
      const coverDomain = m.mul(region, roads);
      groundCoverWeight = m.clamp(
        m.mul(coverDomain, m.div(groundCoverWeight, denominator)),
        0,
        1,
      );
      groundCoverGrassShare = m.min(
        groundCoverWeight,
        m.mul(
          m.mul(coverDomain, flat),
          m.div(groundCoverGrassShare, denominator),
        ),
      );
      const patch = m.add(
        m.constant(c.patchMinimum),
        m.mul(
          m.constant(1 - c.patchMinimum),
          m.clamp(input.distortNoise, 0, 1),
        ),
      );
      const covered = m.mul(
        m.mul(m.mul(locality, flat), patch),
        m.add(
          m.mul(sedge, m.constant(c.sedgeCover)),
          m.mul(turf, m.constant(c.turfCover)),
        ),
      );
      const exposed = m.mul(m.mul(locality, cut), m.constant(c.cutExposure));
      const rockShare = m.mul(
        m.constant(c.cutRockShare),
        m.smoothstep(
          m.constant(c.cutRockStart),
          m.constant(c.cutRockEnd),
          m.clamp(input.slope, 0, 1),
        ),
      );
      const rock = m.mul(exposed, rockShare);
      // The authored cut face continues into its wet toe. Unlike vegetation,
      // bedrock does not stop at the dry-height gate. The existing warped
      // bed-to-inner entry, outer exit, normalized angular overlap, slope and
      // road masks bound this transfer; pond wetness still applies afterwards.
      const soilRock = m.mul(
        m.mul(m.mul(m.mul(region, roads), cut), m.constant(c.cutExposure)),
        rockShare,
      );
      // Explicit shallow mineral substrate, including the submerged toe. It
      // transfers existing soil only: no vegetation, wetness or height change.
      // Keep historical families' arithmetic and node graph exactly unchanged.
      let mineralSoilToRock: T | undefined;
      if (f.sectors.some((sector) => sector.surface === "mineral-shore")) {
        const mineralHeight = m.sub(
          one,
          m.smoothstep(
            m.constant(c.mineralFadeStart),
            m.constant(c.mineralFadeEnd),
            m.sub(input.height, m.constant(f.pond.surfaceY)),
          ),
        );
        const mineralPatch = m.add(
          m.constant(c.mineralPatchMinimum),
          m.mul(
            m.constant(1 - c.mineralPatchMinimum),
            m.smoothstep(
              m.constant(c.mineralPatchStart),
              m.constant(c.mineralPatchEnd),
              input.distortNoise,
            ),
          ),
        );
        mineralSoilToRock = m.mul(
          m.mul(m.mul(coverDomain, m.div(mineral, denominator)), mineralHeight),
          mineralPatch,
        );
      }
      const shade = m.mul(
        m.mul(locality, flat),
        m.add(
          m.mul(sedge, m.constant(c.sedgeShade)),
          m.mul(turf, m.constant(c.turfShade)),
        ),
      );
      // Keep the existing sheltered silt distinct from an exposed mineral
      // shoulder. Reuse the admitted cutbank span and existing filtered noise;
      // this is not a ring, another height solver, or a vegetation-support mask.
      let substrateSoilToRock: T | undefined;
      if (f.sectors.some((sector) => sector.surface === "cutbank")) {
        const noise = m.clamp(input.distortNoise, 0, 1);
        const height = m.sub(
          m.sub(input.height, m.constant(f.pond.surfaceY)),
          m.mul(
            m.sub(noise, m.constant(0.5)),
            m.constant(2 * c.substrateHeightNoise),
          ),
        );
        const band = m.mul(
          m.smoothstep(
            m.constant(c.substrateRiseStart),
            m.constant(c.substrateRiseEnd),
            height,
          ),
          m.sub(
            one,
            m.smoothstep(
              m.constant(c.substrateFadeStart),
              m.constant(c.substrateFadeEnd),
              height,
            ),
          ),
        );
        const variation = m.add(
          m.constant(c.substratePatchMinimum),
          m.mul(m.constant(1 - c.substratePatchMinimum), noise),
        );
        substrateSoilToRock = m.mul(
          m.mul(m.mul(coverDomain, cut), band),
          m.mul(m.constant(c.substrateMax), variation),
        );
      }
      let mineralAppearance: T | undefined, siltAppearance: T | undefined;
      if (input.includeAppearance) {
        const noise = m.clamp(input.distortNoise, 0, 1);
        const height = m.sub(
          m.sub(input.height, m.constant(f.pond.surfaceY)),
          m.mul(
            m.sub(noise, m.constant(0.5)),
            m.constant(2 * c.appearanceHeightNoise),
          ),
        );
        const rise = m.smoothstep(
          m.constant(c.appearanceRiseStart),
          m.constant(c.appearanceRiseEnd),
          height,
        );
        const appearance = {
          fade(start: number, end: number): T {
            return m.sub(
              one,
              m.smoothstep(m.constant(start), m.constant(end), height),
            );
          },
        };
        const patch = m.add(
          m.constant(c.appearancePatchMinimum),
          m.mul(m.constant(1 - c.appearancePatchMinimum), noise),
        );
        const domain = m.mul(m.mul(coverDomain, rise), patch);
        // Unequal, overlapping authored regions: broad cut-face mineral,
        // a narrower turf toe, and flat sheltered silt. Existing radial/angular
        // feathers and noise-shifted heights avoid a constant shoreline ring.
        mineralAppearance = m.clamp(
          m.mul(
            m.mul(
              domain,
              appearance.fade(c.appearanceFadeStart, c.appearanceFadeEnd),
            ),
            m.add(
              m.add(cut, m.div(mineral, denominator)),
              m.mul(
                m.mul(turf, m.constant(c.turfMineralStrength)),
                appearance.fade(c.turfMineralFadeStart, c.turfMineralFadeEnd),
              ),
            ),
          ),
          0,
          1,
        );
        siltAppearance = m.clamp(
          m.mul(
            m.mul(m.mul(domain, sedge), flat),
            m.mul(
              m.constant(c.siltStrength),
              appearance.fade(c.siltFadeStart, c.siltFadeEnd),
            ),
          ),
          0,
          1,
        );
      }
      return {
        soilToGrass: covered,
        soilToRock: soilRock,
        ...(mineralSoilToRock !== undefined ? { mineralSoilToRock } : {}),
        ...(substrateSoilToRock !== undefined ? { substrateSoilToRock } : {}),
        ...(mineralAppearance !== undefined ? { mineralAppearance } : {}),
        ...(siltAppearance !== undefined ? { siltAppearance } : {}),
        grassToSoil: m.sub(exposed, rock),
        grassToRock: rock,
        grassShade: m.sub(one, shade),
        groundCoverWeight,
        groundCoverGrassShare,
      };
    },
    bankCompositionAt(
      input: CompactGrassSupportInput,
      includeAppearance = false,
    ): CompactPondBankComposition<number> {
      return operations.bankComposition(
        {
          x: input.surface.x,
          z: input.surface.z,
          height: input.surface.height,
          slope: input.slope,
          distortNoise: input.distortNoise,
          roadInfluence: input.roadInfluence ?? 0,
          field: input.surface.macroField?.pondBankField ?? null,
          ...(includeAppearance ? { includeAppearance: true as const } : {}),
        },
        bankMath,
      );
    },
    /** Release the historical density cap continuously across an authored
     * sector feather. This is establishment, not an extra material mask. */
    bankEstablishmentPlacement(
      selected: number,
      historical: number,
      weight: number,
    ): number {
      const capped = Math.min(selected, historical);
      const influence = Math.max(0, Math.min(1, weight));
      if (influence === 0) return capped;
      if (influence === 1) return selected;
      return capped + (selected - capped) * influence;
    },
    /** Exposed inland mineral substrate must not be diluted back into coastal
     * soil inside the rock layer. Reuse the same local appearance mask; neither
     * outer coverage weights nor wetness/vegetation ownership change here. */
    bankRockSoil<T>(
      soil: T,
      field: CompactPondBankComposition<T> | undefined,
      m: CompactCoastDistributionMath<T>,
    ): T {
      if (field?.substrateSoilToRock === undefined) return soil;
      return m.mul(
        soil,
        m.sub(m.constant(1), m.clamp(field.substrateSoilToRock, 0, 1)),
      );
    },
    /** Linear-space albedo grade, shared by TSL and CPU means.
     * Luminance retains scan contrast; chroma/value define local material art,
     * not baked illumination. Original source maps and coverage stay intact. */
    bankAppearanceAlbedo<T>(
      soil: readonly [T, T, T],
      rock: readonly [T, T, T],
      field: CompactPondBankComposition<T> | undefined,
      m: CompactCoastDistributionMath<T>,
    ): { soil: readonly [T, T, T]; rock: readonly [T, T, T] } {
      if (
        field?.mineralAppearance === undefined ||
        field.siltAppearance === undefined
      )
        return { soil, rock };
      const c = pondBankRecipe;
      const mineral = m.clamp(field.mineralAppearance, 0, 1);
      const silt = m.clamp(field.siltAppearance, 0, 1);
      // Object methods remain self-contained when the factory is detached
      // from a minified keepNames bundle for the real grass worker.
      const grade = {
        luminance(rgb: readonly [T, T, T]): T {
          return m.add(
            m.add(
              m.mul(rgb[0], m.constant(0.2126)),
              m.mul(rgb[1], m.constant(0.7152)),
            ),
            m.mul(rgb[2], m.constant(0.0722)),
          );
        },
        mix(a: T, b: T, weight: T): T {
          return m.add(a, m.mul(m.sub(b, a), weight));
        },
        channel(index: 0 | 1 | 2): readonly [T, T] {
          const mineralAlbedo = m.mul(
            m.add(
              m.mul(rock[index], m.constant(c.mineralChroma)),
              m.mul(
                rockValue,
                m.constant((1 - c.mineralChroma) * c.mineralTint[index]),
              ),
            ),
            m.constant(c.mineralValue),
          );
          const siltAlbedo = m.mul(
            m.add(
              m.mul(soil[index], m.constant(c.siltChroma)),
              m.mul(
                soilValue,
                m.constant((1 - c.siltChroma) * c.siltTint[index]),
              ),
            ),
            m.constant(c.siltValue),
          );
          const mineralTarget = m.clamp(mineralAlbedo, 0, 1);
          const siltTarget = m.clamp(siltAlbedo, 0, 1);
          return [
            grade.mix(
              grade.mix(soil[index], mineralTarget, mineral),
              siltTarget,
              silt,
            ),
            grade.mix(
              grade.mix(rock[index], mineralTarget, mineral),
              siltTarget,
              silt,
            ),
          ];
        },
      };
      const rockValue = grade.luminance(rock),
        soilValue = grade.luminance(soil);
      const red = grade.channel(0),
        green = grade.channel(1),
        blue = grade.channel(2);
      return {
        soil: [red[0], green[0], blue[0]],
        rock: [red[1], green[1], blue[1]],
      };
    },
    bankCompositionWeights<T>(
      weights: readonly [T, T, T, T],
      field: CompactPondBankComposition<T>,
      m: CompactCoastDistributionMath<T>,
    ): readonly [T, T, T, T] {
      const cover = m.mul(weights[1], m.clamp(field.soilToGrass, 0, 1));
      const removed = m.mul(
        weights[0],
        m.clamp(m.add(field.grassToSoil, field.grassToRock), 0, 1),
      );
      const toRock = m.min(
        removed,
        m.mul(weights[0], m.clamp(field.grassToRock, 0, 1)),
      );
      // Consume only the original soil left after groundcover. Never redirect
      // newly exposed grass, or change the existing grass/coastal arithmetic.
      const remainingSoil = m.sub(weights[1], cover);
      const soilRock = m.mul(remainingSoil, m.clamp(field.soilToRock, 0, 1));
      const grass = m.add(m.sub(weights[0], removed), cover);
      const soil = m.add(
        m.sub(remainingSoil, soilRock),
        m.sub(removed, toRock),
      );
      const domain = m.clamp(field.groundCoverWeight, 0, 1);
      const target = m.min(domain, m.clamp(field.groundCoverGrassShare, 0, 1));
      // Replace only the authored fraction of the remaining grass/soil budget.
      // Rock (including its nested coast soil), wetness and coastal weight are
      // untouched. Bounds also protect Float32 near-pure cancellation.
      const transfer = m.max(
        m.sub(m.constant(0), grass),
        m.min(
          soil,
          m.sub(m.mul(m.add(grass, soil), target), m.mul(grass, domain)),
        ),
      );
      const established: readonly [T, T, T, T] = [
        m.add(grass, transfer),
        m.sub(soil, transfer),
        m.add(m.add(weights[2], toRock), soilRock),
        weights[3],
      ];
      // Resolve emergence first. Otherwise overlapping mineral exposure would
      // reduce its grass/soil budget and silently change vegetation support.
      let result = established;
      if (field.mineralSoilToRock !== undefined) {
        const mineral = m.mul(
          established[1],
          m.clamp(field.mineralSoilToRock, 0, 1),
        );
        result = [
          established[0],
          m.sub(established[1], mineral),
          m.add(established[2], mineral),
          established[3],
        ];
      }
      if (field.substrateSoilToRock === undefined) return result;
      // Appearance follows every establishment/mineral transfer. Keeping the
      // grass/coastal references exact also preserves CPU placement eligibility.
      const substrate = m.mul(
        result[1],
        m.clamp(field.substrateSoilToRock, 0, 1),
      );
      return [
        result[0],
        m.sub(result[1], substrate),
        m.add(result[2], substrate),
        result[3],
      ];
    },
    /** Boundary admission returns immutable canonical data, including after
     * structured clone. Per-root calls on that object take the identity path. */
    validatePondDistribution(
      value: unknown,
    ): CompactPondDistributionDescriptor {
      if (value === pondDistribution) return pondDistribution;
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid compact pond distribution");
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("Invalid compact pond distribution");
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 3)
        throw new Error("Invalid compact pond distribution");
      for (const key of keys) {
        if (key !== "id" && key !== "soilFullHeight" && key !== "soilEndHeight")
          throw new Error("Invalid compact pond distribution");
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (
          !property ||
          !property.enumerable ||
          !("value" in property) ||
          property.value !== pondDistribution[key] ||
          (key !== "id" && !Number.isFinite(property.value))
        )
          throw new Error("Invalid compact pond distribution");
      }
      return pondDistribution;
    },
    /** Shared CPU/TSL soil coverage BEFORE the unchanged radial pond envelope.
     * noiseValue is the existing bank distortion, not sampled texture height. */
    pondSoilCoverage<T>(
      relativeHeight: T,
      noiseValue: T,
      descriptor: CompactPondDistributionDescriptor,
      m: CompactPondDistributionMath<T>,
    ): T {
      const selected = operations.validatePondDistribution(descriptor);
      const noiseHeight = m.mul(
        m.sub(noiseValue, m.constant(0.5)),
        m.constant(2 * composition.pondBankNoiseHeight),
      );
      return m.sub(
        m.constant(1),
        m.smoothstep(
          m.add(m.constant(selected.soilFullHeight), noiseHeight),
          m.add(m.constant(selected.soilEndHeight), noiseHeight),
          relativeHeight,
        ),
      );
    },
    getPondMarginRecipe() {
      return pondMarginRecipe;
    },
    /** Same world-anchored field for actual terrain layers and existing grass.
     * It neither samples textures nor bypasses water/road placement admission. */
    pondMargin<T>(
      input: CompactPondMarginInput<T>,
      m: CompactCoastDistributionMath<T>,
    ): CompactPondMargin<T> {
      const zero = m.constant(0),
        one = m.constant(1),
        p = input.pond,
        field = input.field;
      if (!p || !field?.coastalMeadow || !field.pondDistribution)
        return { cover: zero, exposure: zero, shade: one, clumpScale: one };
      operations.validatePondDistribution(field.pondDistribution);
      const c = pondMarginRecipe;
      const dx = m.sub(input.x, p.centerX),
        dz = m.sub(input.z, p.centerZ),
        distanceSquared = m.add(m.mul(dx, dx), m.mul(dz, dz)),
        radiusFull = m.add(p.radius, m.constant(c.radiusFullOffset)),
        radiusEnd = m.add(p.radius, m.constant(c.radiusEndOffset)),
        relativeHeight = m.sub(input.height, p.surfaceY);
      const radial = m.sub(
        one,
        m.smoothstep(
          m.mul(radiusFull, radiusFull),
          m.mul(radiusEnd, radiusEnd),
          distanceSquared,
        ),
      );
      const aboveWater = m.smoothstep(
        m.constant(c.heightRiseStart),
        m.constant(c.heightRiseEnd),
        relativeHeight,
      );
      const upper = m.sub(
        one,
        m.smoothstep(
          m.constant(c.heightFadeStart),
          m.constant(c.heightFadeEnd),
          relativeHeight,
        ),
      );
      const flat = m.sub(
        one,
        m.smoothstep(
          m.constant(c.slopeFadeStart),
          m.constant(c.slopeFadeEnd),
          m.clamp(input.slope, 0, 1),
        ),
      );
      const awayFromRoad = m.sub(
        one,
        m.smoothstep(zero, m.constant(c.roadEnd), input.roadInfluence),
      );
      const locality = m.mul(
        m.mul(m.mul(m.mul(radial, aboveWater), upper), flat),
        awayFromRoad,
      );
      const patch = m.smoothstep(
        m.constant(c.patchStart),
        m.constant(c.patchEnd),
        m.add(
          m.mul(m.clamp(input.meadowNoise, 0, 1), m.constant(c.meadowFraction)),
          m.mul(
            m.clamp(input.distortNoise, 0, 1),
            m.constant(1 - c.meadowFraction),
          ),
        ),
      );
      return {
        cover: m.mul(m.mul(m.constant(c.coverStrength), locality), patch),
        exposure: m.mul(
          m.mul(m.constant(c.exposureStrength), locality),
          m.sub(one, patch),
        ),
        shade: m.sub(
          one,
          m.mul(
            m.mul(m.constant(c.shadeStrength), locality),
            m.add(
              m.constant(c.shadeBase),
              m.mul(m.constant(1 - c.shadeBase), m.sub(one, patch)),
            ),
          ),
        ),
        clumpScale: m.sub(
          one,
          m.mul(
            m.mul(m.constant(c.clumpScaleStrength), locality),
            m.add(
              m.constant(c.clumpScaleBase),
              m.mul(m.constant(1 - c.clumpScaleBase), patch),
            ),
          ),
        ),
      };
    },
    pondMarginAt(input: CompactGrassSupportInput): CompactPondMargin<number> {
      return operations.pondMargin(
        {
          x: input.surface.x,
          z: input.surface.z,
          height: input.surface.height,
          slope: input.slope,
          meadowNoise: input.meadowNoise ?? input.noiseValue,
          distortNoise: input.distortNoise,
          roadInfluence: input.roadInfluence ?? 0,
          pond: input.surface.pond,
          field: input.surface.macroField ?? null,
        },
        distributionMath,
      );
    },
    /** Cover transfers soil to groundcover; exposure then reveals sediment.
     * Ordered convex mixes preserve pure neutral paths and nonnegative budget. */
    applyPondMarginSoil<T>(
      soil: T,
      margin: CompactPondMargin<T>,
      m: CompactCoastDistributionMath<T>,
    ): T {
      const one = m.constant(1);
      const covered = m.mul(soil, m.sub(one, margin.cover));
      return m.add(covered, m.mul(m.sub(one, covered), margin.exposure));
    },
    coastBlend(value: unknown): CompactCoastBlend | undefined {
      if (
        value === undefined ||
        value === "detail-v1" ||
        value === "distribution-v1" ||
        value === "cavity-v1"
      )
        return value;
      throw new Error("Invalid compact coast blend");
    },
    /** One expression shared by real TSL nodes, host CPU and embedded worker.
     * Inputs describe the actual surface; no screen-space or sampled-texture
     * classifier controls grass eligibility. The original wetness is untouched. */
    coastalDistribution<T>(
      input: CompactCoastDistributionInput<T>,
      m: CompactCoastDistributionMath<T>,
    ): CompactCoastDistribution<T> {
      const f = input.field,
        c = f?.coastalDistribution;
      const one = m.constant(1),
        zero = m.constant(0);
      if (!f?.coastalMeadow || !c)
        return { turfRetention: one, bedrockShare: zero };
      const relative = m.div(
        m.sub(input.height, m.constant(f.seaLevel)),
        m.constant(f.baseElevation - f.seaLevel),
      );
      const noise = m.clamp(input.noiseValue, 0, 1);
      const coastStart = m.add(
        m.constant(composition.coastFadeStartLow),
        m.mul(
          noise,
          m.constant(
            composition.coastFadeStartHigh - composition.coastFadeStartLow,
          ),
        ),
      );
      const coastEnd = m.add(
        m.constant(composition.coastFadeEndLow),
        m.mul(
          noise,
          m.constant(
            composition.coastFadeEndHigh - composition.coastFadeEndLow,
          ),
        ),
      );
      const coverage = m.sub(one, m.smoothstep(coastStart, coastEnd, relative));
      const coast = m.smoothstep(
        zero,
        m.constant(c.coastCoverageFull),
        coverage,
      );
      const patch = m.smoothstep(
        m.constant(composition.coastPatchStart),
        m.constant(composition.coastPatchEnd),
        m.clamp(input.meadowNoise, 0, 1),
      );
      const shift = m.mul(
        m.sub(m.mul(patch, m.constant(2)), one),
        m.constant(c.slopeNoise),
      );
      const slope = m.clamp(input.slope, 0, 1);
      const turf = m.sub(
        one,
        m.smoothstep(
          m.add(m.constant(c.turfSlopeStart), shift),
          m.add(m.constant(c.turfSlopeEnd), shift),
          slope,
        ),
      );
      const bedrockShare = m.smoothstep(
        m.constant(c.bedrockSlopeStart),
        m.constant(c.bedrockSlopeEnd),
        slope,
      );
      let pondClear = one;
      if (input.pond) {
        const dx = m.sub(input.x, input.pond.centerX),
          dz = m.sub(input.z, input.pond.centerZ);
        const inner = m.add(
          input.pond.radius,
          m.constant(composition.pondBankReach),
        );
        const outer = m.add(inner, m.constant(composition.pondRadialFade));
        // All of the original pond bank, including its radial fade, is kept.
        // The new coastal domain fades IN only beyond that admitted footprint.
        pondClear = m.smoothstep(
          m.mul(inner, inner),
          m.mul(outer, outer),
          m.add(m.mul(dx, dx), m.mul(dz, dz)),
        );
      }
      const locality = m.mul(
        m.mul(coast, pondClear),
        m.sub(one, m.clamp(input.road, 0, 1)),
      );
      return {
        turfRetention: m.sub(one, m.mul(locality, m.sub(one, turf))),
        bedrockShare,
      };
    },
    /** Conserved material reassignment shared by CPU mean color and all PBR
     * channels. It only removes available grass, never existing rock or soil. */
    coastalDistributionWeights<T>(
      weights: readonly [T, T, T, T],
      distribution: CompactCoastDistribution<T>,
      m: CompactCoastDistributionMath<T>,
    ): readonly [T, T, T, T] {
      const transfer = m.min(
        weights[0],
        m.max(
          m.constant(0),
          m.mul(
            weights[0],
            m.sub(m.constant(1), m.clamp(distribution.turfRetention, 0, 1)),
          ),
        ),
      );
      const toRock = m.min(
        transfer,
        m.max(
          m.constant(0),
          m.mul(transfer, m.clamp(distribution.bedrockShare, 0, 1)),
        ),
      );
      return [
        m.sub(weights[0], transfer),
        m.add(weights[1], m.sub(transfer, toRock)),
        m.add(weights[2], toRock),
        weights[3],
      ];
    },
    coastalDistributionAt(
      input: CompactGrassSupportInput,
      resolvedRoad?: number,
    ): CompactCoastDistribution<number> {
      const field = input.surface.macroField ?? null;
      if (!field?.coastalDistribution)
        return { turfRetention: 1, bedrockShare: 0 };
      let road = resolvedRoad;
      if (road === undefined) {
        const pond = operations.pondWeights({
          ...input.surface,
          noiseValue: input.distortNoise,
        });
        const baseRoad = operations.weights({
          noiseValue: input.noiseValue,
          distortNoise: input.distortNoise,
          slope: input.slope,
          roadInfluence: input.roadInfluence ?? 0,
        }).road;
        road = operations.wornTurfWeights({
          x: input.surface.x,
          z: input.surface.z,
          meadowNoise: input.meadowNoise ?? input.noiseValue,
          distortNoise: input.distortNoise,
          slope: input.slope,
          roadInfluence: input.roadInfluence ?? 0,
          road: baseRoad,
          pondSoil: pond.soil,
          coastalCoverage:
            operations.coastalGroundCover({
              height: input.surface.height,
              noiseValue: input.noiseValue,
              distortNoise: input.distortNoise,
              field,
            }) *
            (1 - pond.soil),
          field,
        }).road;
      }
      return operations.coastalDistribution(
        {
          x: input.surface.x,
          z: input.surface.z,
          height: input.surface.height,
          slope: input.slope,
          noiseValue: input.noiseValue,
          meadowNoise: input.meadowNoise ?? input.noiseValue,
          road,
          pond: input.surface.pond,
          field,
        },
        distributionMath,
      );
    },
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
    macroField(
      profile: WorldTerrainProfile,
      blend?: CompactCoastBlend,
      pondBlend?: CompactPondBlend,
      bankField?: CompactPondBankField | null,
    ): CompactTerrainMacroField | null {
      const selected = operations.coastBlend(blend);
      const selectedPond = operations.pondBlend(pondBlend);
      if (selectedPond === "composition-v1" && bankField === undefined)
        throw new Error(
          "Pond composition requires an explicit admitted bank field",
        );
      const admittedBankField =
        selectedPond === "composition-v1" && bankField
          ? operations.validatePondBankField(bankField)
          : null;
      // Contact substrate belongs to the admitted bank, not a global old-site
      // decal. Remote composition jobs without a pond cannot resurrect it.
      const contactGround =
        selectedPond === "composition-v1" && !admittedBankField
          ? Object.freeze([])
          : admittedBankField?.zoneId === "haven_pond_floor" &&
              admittedBankField.pond.radius === 27
            ? Object.freeze(
                admittedBankField.sectors
                  .filter(
                    (sector) =>
                      sector.surface === "cutbank" ||
                      sector.surface === "dry-turf",
                  )
                  .map((sector) => {
                    const inner = sector.innerRadius + 0.35;
                    const outer = Math.min(
                      sector.outerRadius ?? inner + 1.5,
                      inner + 2,
                    );
                    const dx = Math.cos(sector.bearing),
                      dz = Math.sin(sector.bearing);
                    return Object.freeze({
                      startX: admittedBankField.centerX + dx * inner,
                      startZ: admittedBankField.centerZ + dz * inner,
                      endX: admittedBankField.centerX + dx * outer,
                      endZ: admittedBankField.centerZ + dz * outer,
                      coreRadius: 0.4,
                      outerRadius: 1.2,
                      strength: 0.6,
                    });
                  }),
              )
            : pondContactGround;
      if (
        profile.algorithm !== "compact-island-sculpt-v2" &&
        profile.algorithm !== "compact-island-sculpt-v3" &&
        profile.algorithm !== "compact-island-sculpt-v4" &&
        profile.algorithm !== "compact-island-sculpt-v5"
      ) {
        if (selected === "distribution-v1")
          throw new Error("Coast distribution requires compact sculpt terrain");
        if (
          selectedPond === "shore-contact-v1" ||
          selectedPond === "composition-v1"
        )
          throw new Error("Pond distribution requires compact sculpt terrain");
        return null;
      }
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
      const coastalMeadow = profile.southernMeadow
        ? {
            coastalMeadow: true as const,
            ...(selected === "distribution-v1" ? { coastalDistribution } : {}),
            ...(selectedPond === "shore-contact-v1"
              ? { pondDistribution }
              : {}),
            ...(selectedPond === "composition-v1"
              ? { pondBankField: admittedBankField }
              : {}),
            ...(profile.id === "compact-duel-island-v6"
              ? { bankVerge, pondContactGround: contactGround }
              : {}),
          }
        : {};
      if (selected === "distribution-v1" && !profile.southernMeadow)
        throw new Error(
          "Coast distribution requires the admitted coastal meadow",
        );
      if (
        (selectedPond === "shore-contact-v1" ||
          selectedPond === "composition-v1") &&
        !profile.southernMeadow
      )
        throw new Error(
          "Pond distribution requires the admitted coastal meadow",
        );
      if (!profile.havenShoulder)
        return Object.freeze({ ...field, ...coastalMeadow });
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
        ...coastalMeadow,
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
    /** Candidate mineral-to-meadow support, shared by pixels and grass roots. */
    coastalGroundCover(input: {
      height: number;
      noiseValue: number;
      distortNoise: number;
      field: CompactTerrainMacroField | null;
    }) {
      if (!input.field?.coastalMeadow) return 0;
      const c = composition;
      const noise = Math.max(0, Math.min(1, input.noiseValue));
      const edge = Math.max(0, Math.min(1, input.distortNoise));
      const patch = math.smooth(
        c.coastPatchStart,
        c.coastPatchEnd,
        noise + (edge - 0.5) * c.coastEdgeNoise,
      );
      return (
        1 -
        math.smooth(
          math.mix(c.coastalGroundFullLow, c.coastalGroundFullHigh, patch),
          math.mix(c.coastalGroundEndLow, c.coastalGroundEndHigh, patch),
          input.height - input.field.seaLevel,
        )
      );
    },
    /** Existing rock redistribution; candidate ground support is independent. */
    coastWeights(input: {
      x: number;
      z: number;
      height: number;
      noiseValue: number;
      distortNoise: number;
      westRock: number;
      slope: number;
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
          (1 - c.coastRidgeRock * Math.max(0, Math.min(1, input.westRock))) *
          // Dirt is projected in world XZ. Keep steep faces on the existing
          // triplanar rock instead of stretching overhead soil down the bank.
          (1 - math.smooth(c.cliffStart, c.cliffEnd, input.slope)),
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
    pondWeights(
      input: {
        x: number;
        z: number;
        height: number;
        noiseValue: number;
        pond: CompactTerrainPond | null;
      },
      descriptor?: CompactPondDistributionDescriptor,
      margin?: CompactPondMargin<number>,
    ): { soil: number; wetness: number; cliffSoil?: number } {
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
      const historical = {
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
      if (!descriptor) return historical;
      const soil =
        region *
        operations.pondSoilCoverage(
          relativeHeight,
          input.noiseValue,
          descriptor,
          distributionMath,
        );
      return {
        soil: margin
          ? operations.applyPondMarginSoil(soil, margin, distributionMath)
          : soil,
        wetness: historical.wetness,
        cliffSoil: historical.soil,
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
    grassColorGrade(value: unknown): CompactGrassColorGrade | undefined {
      if (value === undefined || value === grassColorGradeDescriptor.id)
        return value;
      throw new Error("Invalid compact grass color grade");
    },
    getGrassColorGrade(): CompactGrassColorGradeDescriptor {
      return grassColorGradeDescriptor;
    },
    meadowTint(noiseValue: number, macroDry = 0, strength = 1) {
      const c = composition;
      const dryness = math.mix(
        c.meadowDryLow,
        c.meadowDryHigh,
        math.smooth(c.meadowDryStart, c.meadowDryEnd, noiseValue),
      );
      const tint = [
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
      return strength === 1
        ? tint
        : tint.map((channel) => math.mix(1, channel, strength));
    },
    weights(input: {
      noiseValue: number;
      slope: number;
      roadInfluence: number;
      distortNoise?: number;
      pondSurface?: { soil: number; wetness: number; cliffSoil?: number };
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
          (1 - (input.pondSurface?.cliffSoil ?? input.pondSurface?.soil ?? 0)),
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
    /** Missing coordinates deliberately mean no local edit, not (0,0). */
    bankVergeLocality(
      x: number | undefined,
      z: number | undefined,
      field: Pick<
        CompactTerrainMacroField,
        "coastalMeadow" | "bankVerge"
      > | null,
    ): number {
      const verge = field?.coastalMeadow ? field.bankVerge : undefined;
      if (!verge || x === undefined || z === undefined) return 0;
      if (
        x <= verge.minX ||
        x >= verge.maxX ||
        z <= verge.minZ ||
        z >= verge.maxZ
      )
        return 0;
      return (
        math.smooth(verge.minX, verge.minX + verge.feather, x) *
        (1 - math.smooth(verge.maxX - verge.feather, verge.maxX, x)) *
        math.smooth(verge.minZ, verge.minZ + verge.feather, z) *
        (1 - math.smooth(verge.maxZ - verge.feather, verge.maxZ, z))
      );
    },
    /** Post-acceptance clump scale. No density, random draw or exclusion edits. */
    bankVergeClumpScale(
      x: number,
      z: number,
      roadInfluence: number,
      field: CompactTerrainMacroField | null,
    ): number {
      const locality = operations.bankVergeLocality(x, z, field);
      if (locality === 0) return 1;
      const verge = field!.bankVerge!;
      return (
        1 -
        (1 - verge.minimumScale) *
          locality *
          math.smooth(verge.wearStart, verge.wearEnd, roadInfluence)
      );
    },
    /** Same connected wear for the soil surface and existing clump appearance. */
    bankVergeWear(
      x: number | undefined,
      z: number | undefined,
      field: Pick<
        CompactTerrainMacroField,
        "coastalMeadow" | "bankVerge"
      > | null,
    ): number {
      const locality = operations.bankVergeLocality(x, z, field);
      if (locality === 0) return 0;
      let wear = 0;
      for (const ribbon of field!.bankVerge!.wear)
        wear = Math.max(wear, math.ribbon(x!, z!, ribbon));
      return locality * wear;
    },
    /** Vertical appearance only; physical eligibility and root scale stay separate. */
    bankVergeHeightScale(
      x: number | undefined,
      z: number | undefined,
      field: Pick<
        CompactTerrainMacroField,
        "coastalMeadow" | "bankVerge"
      > | null,
    ): number {
      const locality = operations.bankVergeLocality(x, z, field);
      if (locality === 0) return 1;
      const verge = field!.bankVerge!;
      return (
        math.mix(1, verge.heightScale, locality) +
        operations.bankVergeWear(x, z, field) *
          (verge.wornHeightScale - verge.heightScale)
      );
    },
    /** Same grass-only reflectance multiplier used by the local GPU surface. */
    bankVergeGrassTint(
      x: number | undefined,
      z: number | undefined,
      field: Pick<
        CompactTerrainMacroField,
        "coastalMeadow" | "bankVerge"
      > | null,
    ): readonly [number, number, number] {
      const locality = operations.bankVergeLocality(x, z, field);
      if (locality === 0) return [1, 1, 1];
      const tint = field!.bankVerge!.grassTint;
      return [
        math.mix(1, tint[0], locality),
        math.mix(1, tint[1], locality),
        math.mix(1, tint[2], locality),
      ];
    },
    /** Appearance-only dry substrate; existing edge noise adds no new sample. */
    pondContactSoil(
      x: number | undefined,
      z: number | undefined,
      distortNoise: number,
      field: CompactTerrainMacroField | null,
    ): number {
      if (
        !field?.coastalMeadow ||
        !field.pondContactGround ||
        x === undefined ||
        z === undefined
      )
        return 0;
      let contact = 0;
      for (const ribbon of field.pondContactGround)
        contact = Math.max(contact, math.ribbon(x, z, ribbon));
      return contact * (0.8 + 0.2 * Math.max(0, Math.min(1, distortNoise)));
    },
    /** Worn turf reflectance, separate from the unchanged physical support. */
    wornTurfWeights(input: {
      x?: number;
      z?: number;
      meadowNoise: number;
      distortNoise: number;
      slope: number;
      roadInfluence: number;
      road: number;
      pondSoil: number;
      coastalCoverage: number;
      field: CompactTerrainMacroField | null;
    }) {
      if (!input.field?.coastalMeadow) return { soil: 0, road: input.road };
      const c = composition;
      const patch = math.smooth(
        c.turfPatchStart,
        c.turfPatchEnd,
        Math.max(0, Math.min(1, input.meadowNoise)) * c.turfMeadowFraction +
          Math.max(0, Math.min(1, input.distortNoise)) *
            (1 - c.turfMeadowFraction),
      );
      const land =
        (1 - Math.max(0, Math.min(1, input.pondSoil))) *
        (1 - Math.max(0, Math.min(1, input.coastalCoverage)));
      const patchSoil =
        patch *
        (1 -
          math.smooth(
            c.turfFlatStart,
            c.turfFlatEnd,
            Math.max(0, Math.min(1, input.slope)),
          )) *
        c.turfSoilStrength;
      const soil =
        Math.max(
          patchSoil,
          operations.pondContactSoil(
            input.x,
            input.z,
            input.distortNoise,
            input.field,
          ),
        ) * land;
      const edge = math.smooth(
        math.mix(c.turfEdgeStartLow, c.turfEdgeStartHigh, patch),
        math.mix(c.turfEdgeEndLow, c.turfEdgeEndHigh, patch),
        input.road,
      );
      return {
        soil,
        // Keep the fully worn core and all paint beyond the grass cutoff
        // exactly as before. Only the already-partial shoulder is reshaped.
        road: math.mix(
          input.road,
          edge,
          (1 -
            math.smooth(c.turfCoreStart, c.turfCoreEnd, input.roadInfluence)) *
            land *
            (1 - operations.bankVergeLocality(input.x, input.z, input.field)),
        ),
      };
    },
    /** Original acceptance field, retained for the worker's seeded RNG stream. */
    grassSupportBeforeCoast(input: CompactGrassSupportInput) {
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
    /** Physical grass-layer support BEFORE road suppression by the generator. */
    grassSupport(input: CompactGrassSupportInput) {
      const descriptor = input.surface.macroField?.pondDistribution;
      let beforeCoast: number;
      if (descriptor) {
        const { dirt, cliff } = operations.weights({
          noiseValue: input.noiseValue,
          distortNoise: input.distortNoise,
          slope: input.slope,
          roadInfluence: 0,
          pondSurface: operations.pondWeights(
            { ...input.surface, noiseValue: input.distortNoise },
            descriptor,
            operations.pondMarginAt(input),
          ),
          macroSurface: operations.macroWeights(
            input.surface.x,
            input.surface.z,
            input.noiseValue,
            input.surface.macroField ?? null,
          ),
        });
        beforeCoast = (1 - dirt) * (1 - cliff);
      } else beforeCoast = operations.grassSupportBeforeCoast(input);
      if (input.surface.macroField?.pondBankField) {
        const base = operations.weights({
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
            input.surface.macroField,
          ),
        });
        beforeCoast = operations.bankCompositionWeights(
          [beforeCoast, base.dirt * (1 - base.cliff), base.cliff, 0],
          operations.bankCompositionAt(input),
          distributionMath,
        )[0];
      }
      const support =
        beforeCoast *
        (1 -
          operations.coastalGroundCover({
            height: input.surface.height,
            noiseValue: input.noiseValue,
            distortNoise: input.distortNoise,
            field: input.surface.macroField ?? null,
          }));
      return input.surface.macroField?.coastalDistribution
        ? support * operations.coastalDistributionAt(input).turfRetention
        : support;
    },
    /**
     * sampleNoiseCPU(x,z,0.0008) and geometric
     * slope=1-abs(normal.y). roadInfluence is RAW mask/canonical path influence;
     * the same final smoothstep as TerrainShader is applied here exactly once.
     */
    sample(input: {
      noiseValue: number;
      grassColorGrade?: CompactGrassColorGrade;
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
      const grade = operations.grassColorGrade(input.grassColorGrade);
      const pondMargin = input.surface?.macroField?.pondDistribution
        ? operations.pondMarginAt({ ...input, surface: input.surface })
        : null;
      const bankComposition = input.surface?.macroField?.pondBankField
        ? operations.bankCompositionAt(
            { ...input, surface: input.surface },
            true,
          )
        : null;
      // Distortion noise wears path and pond margins, not meadow or cliff
      // classification. The same mean applies to both PBR projections.
      const pondSurface = input.surface
        ? operations.pondWeights(
            { ...input.surface, noiseValue: input.distortNoise },
            input.surface.macroField?.pondDistribution,
            pondMargin ?? undefined,
          )
        : { soil: 0, wetness: 0 };
      // Existing cliff suppression and contact/talus/worn-turf admission retain
      // their original bank extent; only base soil coverage is narrowed.
      const cliffSoil = pondSurface.cliffSoil ?? pondSurface.soil;
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
            slope: input.slope,
            field: input.surface.macroField ?? null,
          })
        : { soil: 0, wetness: 0 };
      const coastalGround = input.surface
        ? operations.coastalGroundCover({
            height: input.surface.height,
            noiseValue: input.noiseValue,
            distortNoise: input.distortNoise,
            field: input.surface.macroField ?? null,
          }) *
          (1 - cliffSoil)
        : 0;
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
        input.surface?.macroField?.coastalMeadow
          ? composition.coastalMeadowTintStrength
          : 1,
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
      const talus = authored.talus * (1 - cliffSoil);
      const wornTurf = input.surface?.macroField?.coastalMeadow
        ? operations.wornTurfWeights({
            x: input.surface?.x,
            z: input.surface?.z,
            meadowNoise: input.meadowNoise ?? input.noiseValue,
            distortNoise: input.distortNoise,
            slope: input.slope,
            roadInfluence: input.roadInfluence,
            road,
            pondSoil: cliffSoil,
            coastalCoverage: coastalGround,
            field: input.surface.macroField,
          })
        : null;
      const bankGrassTint =
        grade && input.surface?.macroField?.bankVerge
          ? operations.bankVergeGrassTint(
              input.surface.x,
              input.surface.z,
              input.surface.macroField,
            )
          : null;
      const bankWear =
        grade && input.surface?.macroField?.coastalMeadow
          ? operations.bankVergeWear(
              input.surface.x,
              input.surface.z,
              input.surface.macroField,
            )
          : 0;
      let distributedWeights:
        readonly [number, number, number, number] | undefined;
      if (
        input.surface &&
        (input.surface.macroField?.coastalDistribution || bankComposition)
      ) {
        const distribution = operations.coastalDistributionAt(
          { ...input, surface: input.surface },
          wornTurf?.road ?? road,
        );
        if (
          distribution.turfRetention !== 1 ||
          (bankComposition &&
            (bankComposition.soilToGrass !== 0 ||
              bankComposition.soilToRock !== 0 ||
              (bankComposition.mineralSoilToRock ?? 0) !== 0 ||
              (bankComposition.substrateSoilToRock ?? 0) !== 0 ||
              bankComposition.grassToSoil !== 0 ||
              bankComposition.grassToRock !== 0 ||
              bankComposition.groundCoverWeight !== 0))
        ) {
          // Decompose the SAME ordered macro material blends used below. This
          // is a mean-PBR root color, not an added tint or a GPU texel claim.
          let weights: readonly [number, number, number, number] = [
            1 - dirt,
            dirt,
            0,
            0,
          ];
          const accumulator = {
            blend(
              target: readonly [number, number, number, number],
              amount: number,
            ) {
              weights = [
                math.mix(weights[0], target[0], amount),
                math.mix(weights[1], target[1], amount),
                math.mix(weights[2], target[2], amount),
                math.mix(weights[3], target[3], amount),
              ];
            },
          };
          if (wornTurf) accumulator.blend([0, 1, 0, 0], wornTurf.soil);
          if (bankWear > 0) accumulator.blend([0, 1, 0, 0], bankWear);
          if (havenGround) {
            accumulator.blend(
              [
                0,
                1 - composition.havenTalusRockFraction,
                composition.havenTalusRockFraction,
                0,
              ],
              talus,
            );
            accumulator.blend([0, 1, 0, 0], authored.wear);
          }
          if (coastalGround > 0) accumulator.blend([0, 0, 0, 1], coastalGround);
          accumulator.blend([0, 0, 1, 0], cliff);
          accumulator.blend([0, 1, 0, 0], wornTurf?.road ?? road);
          distributedWeights = operations.coastalDistributionWeights(
            weights,
            distribution,
            distributionMath,
          );
          if (bankComposition)
            distributedWeights = operations.bankCompositionWeights(
              distributedWeights,
              bankComposition,
              distributionMath,
            );
        }
      }
      const rockSoil = operations.bankRockSoil(
        coast.soil,
        bankComposition ?? undefined,
        distributionMath,
      );
      const bankAlbedo = bankComposition
        ? operations.bankAppearanceAlbedo(
            [palette.dirt[0], palette.dirt[1], palette.dirt[2]],
            [palette.rock[0], palette.rock[1], palette.rock[2]],
            bankComposition,
            distributionMath,
          )
        : null;
      const result = palette.grass.map((grass, channel) => {
        const soil = bankAlbedo?.soil[channel] ?? palette.dirt[channel];
        const rock =
          math.mix(
            bankAlbedo?.rock[channel] ?? palette.rock[channel],
            soil,
            rockSoil,
          ) * math.mix(1, composition.coastWetAlbedo, coast.wetness);
        if (distributedWeights) {
          const grassDiffuse =
            grass *
            (havenGround && !input.surface?.macroField?.coastalMeadow
              ? 1
              : meadowTint[channel]) *
            (grade ? grassColorGradeDescriptor.linearMultipliers[channel] : 1) *
            (bankGrassTint?.[channel] ?? 1) *
            (pondMargin?.shade ?? 1) *
            (bankComposition?.grassShade ?? 1);
          const coastalSoil =
            palette.dirt[channel] *
            math.mix(1, composition.coastWetAlbedo, coast.wetness);
          return (
            (grassDiffuse * distributedWeights[0] +
              soil * distributedWeights[1] +
              rock * distributedWeights[2] +
              coastalSoil * distributedWeights[3]) *
            variation *
            wetAlbedo
          );
        }
        let ground = math.mix(
          grass *
            (havenGround && !input.surface?.macroField?.coastalMeadow
              ? 1
              : meadowTint[channel]) *
            (grade ? grassColorGradeDescriptor.linearMultipliers[channel] : 1) *
            (bankGrassTint?.[channel] ?? 1) *
            (pondMargin?.shade ?? 1) *
            (bankComposition?.grassShade ?? 1),
          soil,
          dirt,
        );
        if (wornTurf) ground = math.mix(ground, soil, wornTurf.soil);
        if (bankWear > 0) ground = math.mix(ground, soil, bankWear);
        if (havenGround) {
          ground = math.mix(
            ground,
            math.mix(soil, rock, composition.havenTalusRockFraction),
            talus,
          );
          ground = math.mix(ground, soil, authored.wear);
        }
        if (coastalGround > 0)
          ground = math.mix(
            ground,
            palette.dirt[channel] *
              math.mix(1, composition.coastWetAlbedo, coast.wetness),
            coastalGround,
          );
        return (
          math.mix(
            math.mix(ground, rock, cliff),
            soil,
            wornTurf?.road ?? road,
          ) *
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
