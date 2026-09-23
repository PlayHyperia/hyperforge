/** Explicit geometry/addressing agreement, never inferred from buffer capacity.
 * Historical fine revisions remain selectable for paired native qualification. */
export type FineGrassGeometryLayout =
  | "fine-linear-sweep-3seg-v1"
  | "fine-linear-sweep-near4-v1"
  | "fine-folded-lancet-v1";

/** Shared opt-in flex contract. World wind keeps its configured maximum, while
 * shorter/scaled blades flex in proportion to their own authored height.
 * B(t) is the same vertical quadratic used by the geometry and normal graph. */
export const FINE_GRASS_HEIGHT_FLEX_RESPONSE = Object.freeze({
  id: "height-flex-v1",
  controlHeight: 0.76,
  tipHeight: 0.95,
  maximumHeight: 0.86,
} as const);

/** CPU counterpart of the actual vertex response, including the exact root
 * limit. Inputs are already admitted geometry/instance values. Both road and
 * whole-clump sweeps must use this: intermediate rows can exceed t^1.8 even
 * though the tip never exceeds the previous configured wind amplitude. */
export function getGrassBladeWindFactor(
  t: number,
  sourceY: number,
  scale: number,
  geometryLayout?: FineGrassGeometryLayout,
): number {
  if (geometryLayout !== "fine-folded-lancet-v1") return t ** 1.8;
  const { controlHeight, tipHeight, maximumHeight } =
    FINE_GRASS_HEIGHT_FLEX_RESPONSE;
  const curve = t * (2 * controlHeight + t * (tipHeight - 2 * controlHeight));
  const amplitude = Math.min(
    1,
    (scale * sourceY) / (Math.max(curve, 1e-5) * maximumHeight),
  );
  const heightFraction = curve / tipHeight;
  return amplitude * heightFraction * heightFraction;
}

/** Existing edge/root/tip vertices stay at 0..6. Only the two interior
 * centerline vertices are appended, at 7 and 8 respectively. */
export const FINE_GRASS_FOLDED_BLADE_INDICES = Object.freeze([
  0, 1, 7, 0, 7, 2, 1, 3, 7, 2, 7, 4, 7, 8, 4, 7, 3, 8, 3, 5, 8, 4, 8, 6, 8, 5,
  6,
] as const);

function tier(
  geometryLayout: FineGrassGeometryLayout | "ordinary-v1",
  lod: number,
  bladesPerClump: number,
  bladeSegments: number,
  verticesPerBlade = bladeSegments * 2 + 1,
  trianglesPerBlade = bladeSegments * 2 - 1,
) {
  return Object.freeze({
    geometryLayout,
    lod,
    bladesPerClump,
    bladeSegments,
    verticesPerBlade,
    verticesPerClump: bladesPerClump * verticesPerBlade,
    trianglesPerClump: bladesPerClump * trianglesPerBlade,
    rootComponents: 2 as const,
  });
}

const layouts = Object.freeze({
  "ordinary-v1": Object.freeze([
    tier("ordinary-v1", 0, 24, 3),
    tier("ordinary-v1", 1, 12, 2),
    tier("ordinary-v1", 2, 4, 1),
  ]),
  "fine-linear-sweep-3seg-v1": Object.freeze([
    tier("fine-linear-sweep-3seg-v1", 0, 24, 3),
    tier("fine-linear-sweep-3seg-v1", 1, 12, 2),
    tier("fine-linear-sweep-3seg-v1", 2, 4, 1),
  ]),
  "fine-linear-sweep-near4-v1": Object.freeze([
    tier("fine-linear-sweep-near4-v1", 0, 24, 4),
    tier("fine-linear-sweep-near4-v1", 1, 12, 2),
    tier("fine-linear-sweep-near4-v1", 2, 4, 1),
  ]),
  "fine-folded-lancet-v1": Object.freeze([
    tier("fine-folded-lancet-v1", 0, 24, 3, 9, 9),
    tier("fine-folded-lancet-v1", 1, 12, 2),
    tier("fine-folded-lancet-v1", 2, 4, 1),
  ]),
});

export type GrassBladeLayout = ReturnType<typeof tier>;

export function getGrassBladeLayout(
  lod: number,
  geometryLayout?: FineGrassGeometryLayout,
): GrassBladeLayout {
  if (
    !Number.isSafeInteger(lod) ||
    lod < 0 ||
    lod > 2 ||
    (geometryLayout !== undefined &&
      geometryLayout !== "fine-linear-sweep-3seg-v1" &&
      geometryLayout !== "fine-linear-sweep-near4-v1" &&
      geometryLayout !== "fine-folded-lancet-v1")
  )
    throw new Error("Invalid grass blade layout");
  return layouts[geometryLayout ?? "ordinary-v1"][lod];
}
