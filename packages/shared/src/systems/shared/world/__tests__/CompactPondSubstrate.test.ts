import { describe, expect, it } from "vitest";
import type { Node } from "three/webgpu";
import THREE, { float, vec3, vec4 } from "../../../../extras/three/three";
import type { FlatZone } from "../../../../types/world/terrain";
import candidate from "../__fixtures__/inland-pond-basin-candidate.json";
import {
  createCompactTerrainColorOperations,
  type CompactCoastDistributionMath,
  type CompactPondBankComposition,
  type CompactPondBankField,
} from "../CompactTerrainPalette";
import {
  applyCompactPondWetness,
  applyCompactPondRockSoil,
  applyCompactCoastRock,
  blendCompactTerrainLayers,
  createCompactPondBankComposition,
  createCompactPondSurfaceWeights,
  type CompactTerrainLayer,
} from "../CompactTerrainMaterial";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";

const operations = createCompactTerrainColorOperations();
type Operations = typeof operations;
type SupportInput = Parameters<Operations["grassSupport"]>[0] & {
  roadInfluence: number;
};
const pond = candidate.waterBody;
const admitted = operations.pondBankField(
  candidate.flatZone as FlatZone,
  pond,
)!;
const profile = validateWorldTerrainProfile({
  ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  southernMeadow: {
    schemaVersion: 1,
    minX: 304,
    maxX: 500,
    minZ: 345,
    maxZ: 535,
    featherX: 24,
    featherZ: 24,
    northHeight: 26.8,
    southHeight: 25.3,
    crossFall: 1,
    rollAmplitude: 0.65,
    rollWavelength: 100,
  },
});
// Concrete arithmetic adapter for the production generic weight kernel. This
// does not evaluate, replace or simulate TSL; graph checks below use real nodes.
const arithmetic: CompactCoastDistributionMath<number> = {
  constant: (value) => value,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  min: Math.min,
  max: Math.max,
  clamp: THREE.MathUtils.clamp,
  smoothstep: (low, high, value) =>
    THREE.MathUtils.smoothstep(value, low, high),
};

function withoutSubstrate<T>(composition: CompactPondBankComposition<T>) {
  const result = { ...composition };
  delete result.substrateSoilToRock;
  return result;
}

function inputAt(
  field: CompactPondBankField | null = admitted,
  angle = -2.35,
  radius = 18,
  relativeHeight = 0,
  slope = 0.04,
  roadInfluence = 0,
  distortNoise = 0.5,
): SupportInput {
  return {
    noiseValue: 0.5,
    meadowNoise: 0.5,
    distortNoise,
    slope,
    roadInfluence,
    surface: {
      x: pond.centerX + radius * Math.cos(angle),
      z: pond.centerZ + radius * Math.sin(angle),
      height: pond.surfaceY + relativeHeight,
      pond,
      macroField: operations.macroField(
        profile,
        undefined,
        "composition-v1",
        field,
      ),
    },
  };
}

function nodeInput(input: SupportInput) {
  return {
    x: float(input.surface.x),
    z: float(input.surface.z),
    height: float(input.surface.height),
    slope: float(input.slope),
    distortNoise: float(input.distortNoise),
    roadInfluence: float(input.roadInfluence ?? 0),
    field: input.surface.macroField?.pondBankField ?? null,
  };
}

// Assemble the historical support path using its unchanged production
// primitives, removing only the new optional substrate result before weights.
// This is a targeted parity baseline, not an independent terrain oracle.
function supportWithoutSubstrate(input: SupportInput) {
  const field = input.surface.macroField;
  const descriptor = field?.pondDistribution;
  const macroSurface = operations.macroWeights(
    input.surface.x,
    input.surface.z,
    input.noiseValue,
    field ?? null,
  );
  const baseInput = {
    noiseValue: input.noiseValue,
    distortNoise: input.distortNoise,
    slope: input.slope,
    roadInfluence: 0,
    macroSurface,
  };
  let before = operations.grassSupportBeforeCoast(input);
  if (descriptor) {
    const weights = operations.weights({
      ...baseInput,
      pondSurface: operations.pondWeights(
        { ...input.surface, noiseValue: input.distortNoise },
        descriptor,
        operations.pondMarginAt(input),
      ),
    });
    before = (1 - weights.dirt) * (1 - weights.cliff);
  }
  if (field?.pondBankField) {
    const base = operations.weights({
      ...baseInput,
      pondSurface: operations.pondWeights({
        ...input.surface,
        noiseValue: input.distortNoise,
      }),
    });
    before = operations.bankCompositionWeights(
      [before, base.dirt * (1 - base.cliff), base.cliff, 0],
      withoutSubstrate(operations.bankCompositionAt(input)),
      arithmetic,
    )[0];
  }
  const support =
    before *
    (1 -
      operations.coastalGroundCover({
        height: input.surface.height,
        noiseValue: input.noiseValue,
        distortNoise: input.distortNoise,
        field: field ?? null,
      }));
  return field?.coastalDistribution
    ? support * operations.coastalDistributionAt(input).turfRetention
    : support;
}

function overlapField() {
  const zone = structuredClone(candidate.flatZone) as FlatZone;
  const radial = zone.radialPond!;
  const shape = { ...radial.bankSectors![0], bearing: 3.08, halfWidth: 0.65 };
  radial.bankSectors = [{ ...shape }, { ...shape }, { ...shape }];
  radial.bankComposition = {
    schemaVersion: 1,
    sectors: [
      { sectorIndex: 0, surface: "cutbank" },
      {
        sectorIndex: 1,
        surface: "sedge-shelf",
        groundCover: {
          emergenceHeight: 0.04,
          fullHeight: 0.12,
        },
      },
      { sectorIndex: 2, surface: "mineral-shore" },
    ],
  };
  return operations.pondBankField(zone, pond)!;
}

function graph(root: Node) {
  const nodes = new Set<Node>();
  const visit = (node: Node) => {
    if (nodes.has(node)) return;
    nodes.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return nodes;
}

describe("opt-in cutbank substrate (actual CPU kernels and TSL graph, not GPU proof)", () => {
  it("omits the new graph for unselected/null fields and roles without a cutbank", () => {
    for (const surface of [
      "sedge-shelf",
      "dry-turf",
      "mineral-shore",
    ] as const) {
      const zone = structuredClone(candidate.flatZone) as FlatZone;
      zone.radialPond!.bankComposition = {
        schemaVersion: 1,
        sectors: [{ sectorIndex: 0, surface }],
      };
      const field = operations.pondBankField(zone, pond)!;
      const input = inputAt(field);
      expect(operations.bankCompositionAt(input)).not.toHaveProperty(
        "substrateSoilToRock",
      );
      expect(
        createCompactPondBankComposition(nodeInput(input)),
      ).not.toHaveProperty("substrateSoilToRock");
    }
    const remote = inputAt(null);
    expect(operations.bankCompositionAt(remote)).not.toHaveProperty(
      "substrateSoilToRock",
    );
    expect(
      createCompactPondBankComposition(nodeInput(remote)),
    ).not.toHaveProperty("substrateSoilToRock");
    expect(
      operations.macroField(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE),
    ).not.toHaveProperty("pondBankField");
  });

  it("is bounded to the admitted cutbank shoulder with neutral roads, bed, high bank and other sectors", () => {
    const recipe = operations.getPondBankRecipe();
    expect(
      operations.bankCompositionAt(inputAt()).substrateSoilToRock,
    ).toBeGreaterThan(0);
    for (const input of [
      inputAt(admitted, 0),
      inputAt(admitted, 1.4),
      inputAt(admitted, -2.35, 0),
      inputAt(admitted, -2.35, 100),
      inputAt(admitted, -2.35, 18, -1.4),
      inputAt(admitted, -2.35, 18, 1.9),
      inputAt(admitted, -2.35, 18, 0, 0.04, 0.8),
      inputAt(admitted, -2.35, 18, 0, 0.04, 1),
    ]) {
      const composition = operations.bankCompositionAt(input);
      expect(composition.substrateSoilToRock).toBe(0);
      const weights = [0.3, 0.4, 0.2, 0.1] as const;
      expect(
        operations.bankCompositionWeights(weights, composition, arithmetic),
      ).toEqual(
        operations.bankCompositionWeights(
          weights,
          withoutSubstrate(composition),
          arithmetic,
        ),
      );
    }
    for (const noise of [-0.1, 0, 0.5, 1, 1.1]) {
      const mask = operations.bankCompositionAt(
        inputAt(admitted, -2.35, 18, 0, 0.04, 0, noise),
      ).substrateSoilToRock!;
      expect(Number.isFinite(mask)).toBe(true);
      expect(mask).toBeGreaterThanOrEqual(0);
      expect(mask).toBeLessThanOrEqual(recipe.substrateMax);
    }
  });

  it("transfers only remaining soil after overlapping emergence/mineral, conserving every material budget", () => {
    const field = overlapField();
    let changed = 0;
    for (const angle of [-Math.PI + 1e-8, 2.43, 2.7, 3.08, Math.PI - 1e-8])
      for (const height of [-1.4, -0.5, 0, 0.06, 0.12, 0.4, 1, 1.9])
        for (const slope of [0, 0.15, 0.6])
          for (const noise of [0, 0.5, 1]) {
            const input = inputAt(field, angle, 18, height, slope, 0, noise);
            const composition = operations.bankCompositionAt(input);
            expect(operations.grassSupport(input)).toBe(
              supportWithoutSubstrate(input),
            );
            for (const weights of [
              [0.3, 0.4, 0.2, 0.1],
              [1e-20, 2e-20, 3e-20, 4e-20],
              [0, 1, 0, 0],
              [1, 0, 0, 0],
              [0, 0, 0.5, 0.5],
              [0, 0, 0, 0],
            ] as const) {
              const before = operations.bankCompositionWeights(
                weights,
                withoutSubstrate(composition),
                arithmetic,
              );
              const after = operations.bankCompositionWeights(
                weights,
                composition,
                arithmetic,
              );
              const transfer = before[1] * composition.substrateSoilToRock!;
              expect(after[0]).toBe(before[0]);
              expect(after[3]).toBe(before[3]);
              expect(after[1]).toBe(before[1] - transfer);
              expect(after[2]).toBe(before[2] + transfer);
              expect(
                after.every((value) => Number.isFinite(value) && value >= 0),
              ).toBe(true);
              expect(after.reduce<number>((a, b) => a + b, 0)).toBeCloseTo(
                weights.reduce<number>((a, b) => a + b, 0),
                14,
              );
              if (transfer > 0) changed++;
            }
          }
    expect(changed).toBeGreaterThan(0);
    const left = operations.bankCompositionAt(inputAt(field, -Math.PI + 1e-8));
    const right = operations.bankCompositionAt(inputAt(field, Math.PI - 1e-8));
    expect(left.substrateSoilToRock).toBeCloseTo(right.substrateSoilToRock!, 7);
  });

  it("retains actual grass-support values across the admitted inland field and emitted worker operation source", () => {
    const emitted = new Function(
      `return (${createCompactTerrainColorOperations.toString()})()`,
    )() as Operations;
    let changed = 0;
    for (const angle of [-3.13, -2.8, -2.35, -1.8, -1.25, 0, 1.4, 2.7, 3.13])
      for (const radius of [0, 10, 14.5, 18, 20.5, 27, 33, 40])
        for (const height of [-1.4, -0.5, 0, 0.08, 0.4, 1, 1.9]) {
          const input = inputAt(admitted, angle, radius, height);
          const composition = operations.bankCompositionAt(input);
          const serialized = structuredClone(input);
          expect(emitted.bankCompositionAt(serialized)).toEqual(composition);
          expect(emitted.grassSupport(serialized)).toBe(
            operations.grassSupport(input),
          );
          expect(operations.grassSupport(input)).toBe(
            supportWithoutSubstrate(input),
          );
          expect(emitted.sample(serialized)).toEqual(operations.sample(input));
          if (composition.substrateSoilToRock! > 0) changed++;
        }
    expect(changed).toBeGreaterThan(0);
  });

  it("carries the actual substrate node through one final PBR weight vector without new samplers or wetness ownership", () => {
    const input = inputAt();
    const composition = createCompactPondBankComposition(nodeInput(input));
    const substrate = composition.substrateSoilToRock;
    expect(substrate).toBeInstanceOf(THREE.Node);
    if (!substrate) throw new Error("Missing admitted substrate graph");
    const layers: Record<"grass" | "dirt" | "rock", CompactTerrainLayer> = {
      grass: {
        albedo: vec3(0.3, 0.5, 0.1),
        roughness: float(0.9),
        ao: float(0.8),
        worldNormal: vec3(0, 1, 0),
        height: float(0.5),
      },
      dirt: {
        albedo: vec3(0.2, 0.12, 0.05),
        roughness: float(0.7),
        ao: float(0.9),
        worldNormal: vec3(0.1, 1, 0),
        height: float(0.5),
      },
      rock: {
        albedo: vec3(0.3, 0.2, 0.12),
        roughness: float(0.8),
        ao: float(0.7),
        worldNormal: vec3(0, 1, 0.1),
      },
    };
    const nestedSoil = applyCompactPondRockSoil(float(0.6), composition);
    layers.rock = applyCompactCoastRock(layers.rock, layers.dirt, {
      soil: nestedSoil,
      wetness: float(0),
    });
    const blended = blendCompactTerrainLayers(
      layers,
      float(0.4),
      float(0.2),
      float(0.1),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      composition,
    );
    if (!blended.weights)
      throw new Error("Missing production material weights");
    expect(graph(blended.weights).has(substrate)).toBe(true);
    for (const root of [
      blended.albedo,
      blended.roughness,
      blended.ao,
      blended.normal,
    ]) {
      const nodes = graph(root);
      expect(nodes.has(blended.weights)).toBe(true);
      expect(nodes.has(substrate)).toBe(true);
      expect(nodes.has(nestedSoil)).toBe(true);
      expect(
        [...nodes].some((node) => Reflect.get(node, "isTextureNode") === true),
      ).toBe(false);
    }
    const wetness = createCompactPondSurfaceWeights(
      vec3(input.surface.x, input.surface.height, input.surface.z),
      float(input.distortNoise),
      vec4(pond.centerX, pond.centerZ, pond.radius, pond.surfaceY),
    ).wetness;
    expect(graph(wetness).has(substrate)).toBe(false);
    const wet = applyCompactPondWetness(blended, wetness);
    expect(graph(wet.albedo).has(wetness)).toBe(true);
    expect(graph(wet.roughness).has(wetness)).toBe(true);
    expect(wet.ao).toBe(blended.ao);
    expect(wet.normal).toBe(blended.normal);
  });
});
