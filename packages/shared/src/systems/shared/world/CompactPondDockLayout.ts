import type { CompactPondDockPlacement } from "../../../types/world/world-types";
import type { CanonicalGroundLease } from "./CoastalBathymetry";
import type { ElevatedWaterBody } from "./WaterBodyRegistry";
import {
  COMPACT_POND_DOCK_DIMENSIONS,
  getCompactPondDockDirection,
  getCompactPondDockSupportBounds,
} from "./DockDefinition";
import { CollisionFlag, getOppositeWallFlag } from "../movement/CollisionFlags";

/** One shared, retained deck surface for drawing, physics and movement heights. */
export const POND_DOCK_SURFACE = Object.freeze({
  width: COMPACT_POND_DOCK_DIMENSIONS.width,
  length: COMPACT_POND_DOCK_DIMENSIONS.length,
  apronLength: COMPACT_POND_DOCK_DIMENSIONS.landingLength,
  spacing: 0.5,
  deckFreeboard: 0.4,
  boardThickness: 0.12,
  groundClearance: 0.015,
  maxApronRisePerMetre: 0.45,
  maxPostHeight: 5,
});

export type PondDockRail = Readonly<{
  start: Readonly<{ x: number; z: number }>;
  end: Readonly<{ x: number; z: number }>;
}>;

export type GroundedPondDock = Readonly<{
  descriptor: CompactPondDockPlacement;
  waterBodyId: string;
  waterLevel: number;
  deckY: number;
  groundRevision: number;
  bounds: ReturnType<typeof getCompactPondDockSupportBounds>;
  positions: Float32Array;
  indices: Uint16Array;
  tiles: readonly Readonly<{ x: number; z: number }>[];
  walls: readonly Readonly<{ x: number; z: number; flags: number }>[];
  rails: readonly PondDockRail[];
  posts: readonly Readonly<{ x: number; z: number; bottomY: number }>[];
  heightAt(x: number, z: number): number | null;
}>;

/** This supports the admitted 3×6m straight dock recipes, with a fitted 2m
 * shore apron. It never flattens terrain or manufactures a water datum. */
export function groundCompactPondDock(
  descriptor: CompactPondDockPlacement,
  body: ElevatedWaterBody,
  ground: CanonicalGroundLease,
): GroundedPondDock {
  if (
    ![body.centerX, body.centerZ, body.radius, body.surfaceY].every(
      Number.isFinite,
    ) ||
    body.radius <= 0 ||
    body.radius > 32 ||
    body.sourceType !== "explicit"
  )
    throw new Error("Dock requires a finite admitted inland water body");
  if (!ground.isCurrent())
    throw new Error("Dock requires current canonical ground");
  const direction = getCompactPondDockDirection(descriptor.rotation);
  const perpendicular = { x: -direction.z, z: direction.x };
  const point = (forward: number, across: number) => ({
    x: descriptor.x + direction.x * forward + perpendicular.x * across,
    z: descriptor.z + direction.z * forward + perpendicular.z * across,
  });
  const height = (forward: number, across: number) => {
    const p = point(forward, across);
    const y = ground.sampleHeight(p.x, p.z);
    if (!Number.isFinite(y)) throw new Error("Dock ground is nonfinite");
    return y;
  };
  const deckY = Math.fround(body.surfaceY + POND_DOCK_SURFACE.deckFreeboard);
  const bounds = getCompactPondDockSupportBounds(descriptor);
  const columns = 7,
    rows = 17;
  const positions = new Float32Array(columns * rows * 3);
  const indices: number[] = [];
  const startHeights = Array.from({ length: columns }, (_, w) => {
    const across = -1.5 + w * 0.5;
    const y = height(-2, across);
    if (y < body.surfaceY + 0.04 || Math.abs(y - deckY) > 0.6)
      throw new Error("Dock apron requires dry, gently graded shore access");
    if (Math.abs(height(-2.25, across) - y) > 0.12)
      throw new Error("Dock shore entrance has an unsupported ground step");
    return y + POND_DOCK_SURFACE.groundClearance;
  });
  for (let row = 0; row < rows; row++) {
    const forward = -2 + row * 0.5;
    for (let column = 0; column < columns; column++) {
      const across = -1.5 + column * 0.5;
      const p = point(forward, across);
      const terrainY = height(forward, across);
      let y = deckY;
      if (forward < 0) {
        const t = (forward + 2) / 2;
        y = Math.max(
          terrainY + POND_DOCK_SURFACE.groundClearance,
          startHeights[column] + (deckY - startHeights[column]) * t,
        );
      } else {
        if (terrainY > deckY - POND_DOCK_SURFACE.boardThickness)
          throw new Error("Dock deck underside intersects authored ground");
        if (Math.hypot(p.x - body.centerX, p.z - body.centerZ) > body.radius)
          throw new Error("Dock deck escapes its bound water region");
      }
      const i = (row * columns + column) * 3;
      positions[i] = p.x;
      positions[i + 1] = y;
      positions[i + 2] = p.z;
      if (
        row &&
        Math.abs(positions[i + 1] - positions[i + 1 - columns * 3]) >
          0.5 * POND_DOCK_SURFACE.maxApronRisePerMetre
      )
        throw new Error("Dock apron exceeds its movement slope budget");
      if (
        column &&
        Math.abs(positions[i + 1] - positions[i - 2]) >
          0.5 * POND_DOCK_SURFACE.maxApronRisePerMetre
      )
        throw new Error("Dock apron exceeds its transverse slope budget");
    }
  }
  for (let row = 0; row < rows - 1; row++)
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column,
        b = a + 1,
        c = a + columns,
        d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  const heightAt = (x: number, z: number): number | null => {
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new Error("Dock query requires finite coordinates");
    const dx = x - descriptor.x,
      dz = z - descriptor.z;
    const forward = dx * direction.x + dz * direction.z;
    const across = dx * perpendicular.x + dz * perpendicular.z;
    if (forward < -2 || forward > 6 || across < -1.5 || across > 1.5)
      return null;
    const u = (forward + 2) * 2,
      v = (across + 1.5) * 2;
    const row = Math.min(rows - 2, Math.floor(u)),
      column = Math.min(columns - 2, Math.floor(v));
    const a = (row * columns + column) * 3 + 1;
    const fu = u - row,
      fv = v - column;
    const y00 = positions[a],
      y01 = positions[a + 3],
      y10 = positions[a + columns * 3],
      y11 = positions[a + columns * 3 + 3];
    return fu + fv <= 1
      ? y00 + (y10 - y00) * fu + (y01 - y00) * fv
      : y11 + (y01 - y11) * (1 - fu) + (y10 - y11) * (1 - fv);
  };
  // Interior checks catch a curved bank intruding between retained vertices.
  for (let forward = -1.875; forward < 0; forward += 0.25)
    for (let across = -1.375; across < 1.5; across += 0.25) {
      const p = point(forward, across);
      if (heightAt(p.x, p.z)! < height(forward, across) + 0.003)
        throw new Error("Dock apron cannot clear the bank between samples");
    }
  if (height(5.5, 0) > body.surfaceY - 0.25)
    throw new Error("Dock fishing end requires actual open water");
  const tiles: { x: number; z: number }[] = [];
  for (let x = bounds.minX; x < bounds.maxX; x++)
    for (let z = bounds.minZ; z < bounds.maxZ; z++)
      tiles.push(Object.freeze({ x, z }));
  if (tiles.length !== 24)
    throw new Error("Dock support must own exactly 24 aligned movement tiles");

  // Arrival landing: two short shelter rails and an open casting end.
  // Reed jetty: one long windward rail and a deliberate two-metre casting bay.
  const railRanges: readonly (readonly [number, number, number])[] =
    descriptor.recipeId === "haven-fishing-landing-v1"
      ? [
          [-1.5, 0, 4],
          [1.5, 0, 4],
        ]
      : [
          [-1.5, 0, 6],
          [1.5, 0, 2],
          [1.5, 4, 6],
        ];
  const rails: PondDockRail[] = [];
  const walls: { x: number; z: number; flags: number }[] = [];
  for (const [across, from, to] of railRanges) {
    rails.push(
      Object.freeze({
        start: Object.freeze(point(from, across)),
        end: Object.freeze(point(to, across)),
      }),
    );
    const side = Math.sign(across),
      nx = perpendicular.x * side,
      nz = perpendicular.z * side;
    const flag =
      nx === 1
        ? CollisionFlag.WALL_EAST
        : nx === -1
          ? CollisionFlag.WALL_WEST
          : nz === 1
            ? CollisionFlag.WALL_SOUTH
            : CollisionFlag.WALL_NORTH;
    for (let f = from; f < to; f++) {
      const inside = point(f + 0.5, across - side * 0.5);
      const x = Math.floor(inside.x),
        z = Math.floor(inside.z);
      walls.push(Object.freeze({ x, z, flags: flag }));
      walls.push(
        Object.freeze({
          x: x + nx,
          z: z + nz,
          flags: getOppositeWallFlag(flag),
        }),
      );
    }
  }
  // Set the first/last feet half a metre inside the flat platform. Their caps
  // must never project over the fitted apron or outside the walkable deck.
  const posts = [0.5, 2, 4, 5.5].flatMap((forward) =>
    [-1.14, 1.14].map((across) => {
      const p = point(forward, across);
      const bottomY = ground.sampleHeight(p.x, p.z) - 0.15;
      if (
        !Number.isFinite(bottomY) ||
        deckY - bottomY < 0.2 ||
        deckY - bottomY > POND_DOCK_SURFACE.maxPostHeight
      )
        throw new Error("Dock support post has an unsupported ground depth");
      return Object.freeze({ ...p, bottomY });
    }),
  );
  if (!ground.isCurrent())
    throw new Error("Dock ground changed during layout generation");
  return Object.freeze({
    descriptor,
    waterBodyId: body.id,
    waterLevel: body.surfaceY,
    deckY,
    groundRevision: ground.revision,
    bounds,
    positions,
    indices: new Uint16Array(indices),
    tiles: Object.freeze(tiles),
    walls: Object.freeze(walls),
    rails: Object.freeze(rails),
    posts: Object.freeze(posts),
    heightAt,
  });
}
