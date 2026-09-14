/** Explicit geometry/addressing agreement, never inferred from buffer capacity.
 * Both fine revisions remain selectable for paired native qualification. */
export type FineGrassGeometryLayout =
  "fine-linear-sweep-3seg-v1" | "fine-linear-sweep-near4-v1";

function tier(
  geometryLayout: FineGrassGeometryLayout | "ordinary-v1",
  lod: number,
  bladesPerClump: number,
  bladeSegments: number,
) {
  const verticesPerBlade = bladeSegments * 2 + 1;
  return Object.freeze({
    geometryLayout,
    lod,
    bladesPerClump,
    bladeSegments,
    verticesPerBlade,
    verticesPerClump: bladesPerClump * verticesPerBlade,
    trianglesPerClump: bladesPerClump * (bladeSegments * 2 - 1),
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
      geometryLayout !== "fine-linear-sweep-near4-v1")
  )
    throw new Error("Invalid grass blade layout");
  return layouts[geometryLayout ?? "ordinary-v1"][lod];
}
